import type { ActivityItem, ActivityResponse, PullRequestReviewState } from "../activity/types";

type GitHubEvent = {
  id: string;
  type: string;
  actor: {
    login: string;
    url: string;
    avatar_url: string;
  };
  repo: {
    name: string;
    url: string;
  };
  payload: unknown;
  created_at: string;
};

function ghHeaders() {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "activity.2k36.org",
    "x-github-api-version": "2022-11-28",
  };
  return headers;
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 500)}` : "";
    throw new Error(`GitHub API error ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

type RepoApiResponse = {
  fork?: boolean;
};

type PullRequestApiResponse = {
  html_url?: string;
  title?: string;
  body?: string | null;
  merged_at?: string | null;
};

function repoHtmlUrl(repoName: string) {
  return `https://github.com/${repoName}`;
}

function userHtmlUrl(login: string) {
  return `https://github.com/${login}`;
}

function pullRequestHtmlUrl(repoName: string, number: number) {
  return `https://github.com/${repoName}/pull/${number}`;
}

function summarizeText(input: unknown, maxLen = 160) {
  if (typeof input !== "string") return undefined;
  const s = input.replaceAll("\r\n", "\n").replaceAll("\n", " ").replaceAll(/\s+/g, " ").trim();
  if (!s) return undefined;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1).trimEnd()}…`;
}

function reviewStateFromGitHub(input: unknown): PullRequestReviewState {
  if (typeof input !== "string") return "unknown";
  switch (input.toLowerCase()) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes_requested";
    case "commented":
      return "commented";
    case "dismissed":
      return "dismissed";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

function normalizeEventPreview(event: GitHubEvent): ActivityItem | null {
  const actor = {
    login: event.actor.login,
    url: userHtmlUrl(event.actor.login),
    avatarUrl: event.actor.avatar_url,
  };
  const repo = {
    name: event.repo.name,
    url: repoHtmlUrl(event.repo.name),
  };

  const base = {
    id: event.id,
    createdAt: event.created_at,
    actor,
    repo,
  };

  if (event.type === "IssuesEvent") {
    const payload = event.payload as {
      action?: string;
      issue?: { html_url?: string; title?: string; body?: string };
    };
    if (payload.action !== "opened") return null;
    const title = payload.issue?.title?.trim();
    const url = payload.issue?.html_url;
    if (!title || !url) return null;
    return {
      ...base,
      kind: "issue_opened",
      title,
      url,
      summary: summarizeText(payload.issue?.body),
    };
  }

  if (event.type === "PullRequestEvent") {
    const payload = event.payload as {
      action?: string;
      number?: number;
      pull_request?: { number?: number };
    };
    if (payload.action !== "opened" && payload.action !== "closed" && payload.action !== "reopened")
      return null;

    const prNumber = payload.pull_request?.number ?? payload.number;
    if (typeof prNumber !== "number") return null;

    const title =
      payload.action === "opened"
        ? `Opened pull request #${prNumber}`
        : payload.action === "reopened"
          ? `Reopened pull request #${prNumber}`
          : `Closed pull request #${prNumber}`;

    return {
      ...base,
      kind:
        payload.action === "opened"
          ? "pull_request_opened"
          : payload.action === "reopened"
            ? "pull_request_reopened"
            : "pull_request_closed",
      title,
      url: pullRequestHtmlUrl(repo.name, prNumber),
    };
  }

  if (event.type === "IssueCommentEvent") {
    const payload = event.payload as {
      action?: string;
      issue?: { title?: string };
      comment?: { html_url?: string; body?: string };
    };
    if (payload.action !== "created") return null;
    const title = payload.issue?.title?.trim();
    const url = payload.comment?.html_url;
    if (!title || !url) return null;
    return {
      ...base,
      kind: "issue_or_pr_comment",
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    };
  }

  if (event.type === "PullRequestReviewEvent") {
    const payload = event.payload as {
      action?: string;
      pull_request?: { number?: number };
      review?: { html_url?: string; body?: string; state?: string };
    };
    if (payload.action !== "created") return null;

    const prNumber = payload.pull_request?.number;
    if (typeof prNumber !== "number") return null;

    const reviewState = reviewStateFromGitHub(payload.review?.state);
    const summary = summarizeText(payload.review?.body);
    if (reviewState === "commented" && !summary) return null;

    return {
      ...base,
      kind: "pull_request_review",
      title: `Review on pull request #${prNumber}`,
      url: payload.review?.html_url ?? pullRequestHtmlUrl(repo.name, prNumber),
      reviewState,
      summary,
    };
  }

  if (event.type === "PullRequestReviewCommentEvent") {
    const payload = event.payload as {
      action?: string;
      pull_request?: { number?: number };
      comment?: { html_url?: string; body?: string };
    };
    if (payload.action !== "created") return null;

    const prNumber = payload.pull_request?.number;
    const url = payload.comment?.html_url;
    if (typeof prNumber !== "number" || !url) return null;

    return {
      ...base,
      kind: "pull_request_review_comment",
      title: `Review comment on pull request #${prNumber}`,
      url,
      summary: summarizeText(payload.comment?.body),
    };
  }

  if (event.type === "ReleaseEvent") {
    const payload = event.payload as {
      action?: string;
      release?: { html_url?: string; name?: string; tag_name?: string; body?: string };
    };
    if (payload.action !== "published") return null;
    const titleRaw = payload.release?.name?.trim() || payload.release?.tag_name?.trim();
    const url = payload.release?.html_url;
    if (!titleRaw || !url) return null;
    return {
      ...base,
      kind: "release_published",
      title: titleRaw,
      url,
      summary: summarizeText(payload.release?.body),
    };
  }

  return null;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Example:
  // <https://api.github.com/user/123/events?page=2>; rel="next", <...>; rel="last"
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const [rawUrl, ...params] = part
      .trim()
      .split(";")
      .map((s) => s.trim());
    const rel = params.find((p) => p.startsWith("rel="));
    if (rel && rel.includes('"next"')) {
      const m = rawUrl.match(/^<(.+)>$/);
      return m?.[1] ?? null;
    }
  }
  return null;
}

async function fetchEventsPage(
  url: string,
): Promise<{ events: GitHubEvent[]; nextUrl: string | null }> {
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 422) {
    const text = await res.text().catch(() => "");
    // GitHub sometimes returns 422 for deep pagination:
    // {"message":"In order to keep the API fast for everyone, pagination is limited for this resource.", ...}
    if (text.includes("pagination is limited for this resource")) {
      return { events: [], nextUrl: null };
    }
    throw new Error(`GitHub API error 422: ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 500)}` : "";
    throw new Error(`GitHub API error ${res.status}${detail}`);
  }
  const events = (await res.json()) as GitHubEvent[];
  const nextUrl = parseNextLink(res.headers.get("link"));
  return { events, nextUrl };
}

async function isForkRepo(
  repoApiUrl: string,
  memo: Map<string, boolean>,
): Promise<boolean> {
  const cached = memo.get(repoApiUrl);
  if (typeof cached === "boolean") return cached;
  try {
    const repo = await fetchGitHubJson<RepoApiResponse>(repoApiUrl);
    const isFork = repo.fork === true;
    memo.set(repoApiUrl, isFork);
    return isFork;
  } catch {
    // If we can't determine it, do not filter it out.
    memo.set(repoApiUrl, false);
    return false;
  }
}

async function fetchPullRequest(
  prApiUrl: string,
  memo: Map<string, PullRequestApiResponse | null>,
) {
  const cached = memo.get(prApiUrl);
  if (cached !== undefined) return cached;
  try {
    const pr = await fetchGitHubJson<PullRequestApiResponse>(prApiUrl);
    memo.set(prApiUrl, pr);
    return pr;
  } catch {
    memo.set(prApiUrl, null);
    return null;
  }
}

async function normalizeEvent(
  event: GitHubEvent,
  prMemo: Map<string, PullRequestApiResponse | null>,
): Promise<ActivityItem | null> {
  const actor = {
    login: event.actor.login,
    url: userHtmlUrl(event.actor.login),
    avatarUrl: event.actor.avatar_url,
  };
  const repo = {
    name: event.repo.name,
    url: repoHtmlUrl(event.repo.name),
  };

  const base = {
    id: event.id,
    createdAt: event.created_at,
    actor,
    repo,
  };

  if (event.type === "IssuesEvent") {
    const payload = event.payload as {
      action?: string;
      issue?: { html_url?: string; title?: string; body?: string };
    };
    if (payload.action !== "opened") return null;
    const title = payload.issue?.title?.trim();
    const url = payload.issue?.html_url;
    if (!title || !url) return null;
    return {
      ...base,
      kind: "issue_opened",
      title,
      url,
      summary: summarizeText(payload.issue?.body),
    };
  }

  if (event.type === "PullRequestEvent") {
    const payload = event.payload as {
      action?: string;
      number?: number;
      pull_request?: { url?: string; number?: number; merged?: boolean };
    };
    if (payload.action !== "opened" && payload.action !== "closed" && payload.action !== "reopened")
      return null;
    const prApiUrl =
      typeof payload.pull_request?.url === "string"
        ? payload.pull_request.url
        : typeof payload.number === "number"
          ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.number}`
          : null;
    if (!prApiUrl) return null;

    const pr = await fetchPullRequest(prApiUrl, prMemo);
    const title = pr?.title?.trim();
    const url = pr?.html_url;
    if (!title || !url) return null;

    const kind =
      payload.action === "opened"
        ? "pull_request_opened"
        : payload.action === "reopened"
          ? "pull_request_reopened"
          : pr?.merged_at
            ? "pull_request_merged"
            : "pull_request_closed";
    return {
      ...base,
      kind,
      title,
      url,
      summary: summarizeText(pr?.body),
    };
  }

  if (event.type === "IssueCommentEvent") {
    const payload = event.payload as {
      action?: string;
      issue?: { title?: string };
      comment?: { html_url?: string; body?: string };
    };
    if (payload.action !== "created") return null;
    const title = payload.issue?.title?.trim();
    const url = payload.comment?.html_url;
    if (!title || !url) return null;
    return {
      ...base,
      kind: "issue_or_pr_comment",
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    };
  }

  if (event.type === "PullRequestReviewEvent") {
    const payload = event.payload as {
      action?: string;
      pull_request?: { url?: string; number?: number };
      review?: { html_url?: string; body?: string; state?: string };
    };
    if (payload.action !== "created") return null;

    const prApiUrl =
      typeof payload.pull_request?.url === "string"
        ? payload.pull_request.url
        : typeof payload.pull_request?.number === "number"
          ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.pull_request.number}`
          : null;
    if (!prApiUrl) return null;

    const pr = await fetchPullRequest(prApiUrl, prMemo);
    const title = pr?.title?.trim();
    const url = payload.review?.html_url ?? pr?.html_url;
    if (!title || !url) return null;

    const reviewState = reviewStateFromGitHub(payload.review?.state);
    const summary = summarizeText(payload.review?.body);

    // GitHub often emits both PullRequestReviewEvent (state: commented, body: empty)
    // and PullRequestReviewCommentEvent for the same action. The empty review entry
    // is just noise, so we drop it to avoid "duplicate" looking items.
    if (reviewState === "commented" && !summary) return null;

    return {
      ...base,
      kind: "pull_request_review",
      title,
      url,
      reviewState,
      summary,
    };
  }

  if (event.type === "PullRequestReviewCommentEvent") {
    const payload = event.payload as {
      action?: string;
      pull_request?: { url?: string; number?: number };
      comment?: { html_url?: string; body?: string };
    };
    if (payload.action !== "created") return null;
    const prApiUrl =
      typeof payload.pull_request?.url === "string"
        ? payload.pull_request.url
        : typeof payload.pull_request?.number === "number"
          ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.pull_request.number}`
          : null;
    if (!prApiUrl) return null;

    const pr = await fetchPullRequest(prApiUrl, prMemo);
    const title = pr?.title?.trim();
    const url = payload.comment?.html_url;
    if (!title || !url) return null;
    return {
      ...base,
      kind: "pull_request_review_comment",
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    };
  }

  if (event.type === "ReleaseEvent") {
    const payload = event.payload as {
      action?: string;
      release?: { html_url?: string; name?: string; tag_name?: string; body?: string };
    };
    if (payload.action !== "published") return null;
    const titleRaw = payload.release?.name?.trim() || payload.release?.tag_name?.trim();
    const url = payload.release?.html_url;
    if (!titleRaw || !url) return null;
    return {
      ...base,
      kind: "release_published",
      title: titleRaw,
      url,
      summary: summarizeText(payload.release?.body),
    };
  }

  return null;
}

export async function getRecentActivity(options: {
  username: string;
  limit: number;
  perPage?: number;
  maxPages?: number;
}): Promise<ActivityResponse> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100));
  const maxPages = Math.max(1, Math.min(10, options.maxPages ?? 5));

  const items: ActivityItem[] = [];
  const seenUrls = new Set<string>();
  const forkMemo = new Map<string, boolean>();
  const prMemo = new Map<string, PullRequestApiResponse | null>();

  const firstUrl = new URL(`https://api.github.com/users/${options.username}/events/public`);
  firstUrl.searchParams.set("per_page", String(perPage));
  firstUrl.searchParams.set("page", "1");

  let nextUrl: string | null = firstUrl.toString();
  let pageCount = 0;

  while (nextUrl && pageCount < maxPages) {
    pageCount++;
    const { events, nextUrl: next } = await fetchEventsPage(nextUrl);
    if (!events.length) break;

    for (const ev of events) {
      const item = await normalizeEvent(ev, prMemo);
      if (!item) continue;

      // Ignore fork repos
      if (await isForkRepo(ev.repo.url, forkMemo)) continue;

      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      items.push(item);
      if (items.length >= limit) {
        return {
          username: options.username,
          generatedAt: new Date().toISOString(),
          items: items.slice(0, limit),
        };
      }
    }

    nextUrl = next;
  }

  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    username: options.username,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, limit),
  };
}

export async function getRecentActivityPreview(options: {
  username: string;
  limit: number;
  perPage?: number;
}): Promise<ActivityResponse> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100));

  const url = new URL(`https://api.github.com/users/${options.username}/events/public`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", "1");

  const { events } = await fetchEventsPage(url.toString());

  const items: ActivityItem[] = [];
  const seenUrls = new Set<string>();

  for (const ev of events) {
    const item = normalizeEventPreview(ev);
    if (!item) continue;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    items.push(item);
    if (items.length >= limit) break;
  }

  return {
    username: options.username,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, limit),
  };
}
