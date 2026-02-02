import type {
  ActivityErrorInfo,
  ActivityItem,
  ActivityResponse,
  PullRequestReviewState,
} from "../activity/types";
import {
  fetchGitHubJson,
  fetchGitHubResponse,
  GitHubErrorInfo,
  GitHubRequestError,
  GitHubResponseMeta,
} from "./client";

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

type RepoApiResponse = {
  fork?: boolean;
};

type PullRequestApiResponse = {
  html_url?: string;
  title?: string;
  body?: string | null;
  merged_at?: string | null;
};

type PullRequestMemoEntry = PullRequestApiResponse | { error: GitHubErrorInfo } | null;

type RateLimitInfo = {
  remaining?: number;
  reset?: number;
};

type ActivityFetchResult = {
  data: ActivityResponse;
  rateLimit?: RateLimitInfo;
};

type ErrorTracker = {
  partial: boolean;
  errorInfo?: ActivityErrorInfo;
};

const CONCURRENCY_LIMIT = 4;
const REPO_CACHE_TTL_SECONDS = 300;
const PR_CACHE_TTL_SECONDS = 180;

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

function updateRateLimit(target: RateLimitInfo, meta?: GitHubResponseMeta | GitHubErrorInfo) {
  if (!meta) return;
  if ("rateLimitRemaining" in meta && meta.rateLimitRemaining != null)
    target.remaining = meta.rateLimitRemaining;
  if (meta.rateLimitReset != null) target.reset = meta.rateLimitReset;
}

function recordPartial(tracker: ErrorTracker, error: GitHubErrorInfo) {
  tracker.partial = true;
  if (!tracker.errorInfo) tracker.errorInfo = error;
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

function compactRateLimit(rateLimit: RateLimitInfo): RateLimitInfo | undefined {
  if (rateLimit.remaining == null && rateLimit.reset == null) return undefined;
  return rateLimit;
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= limit) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  };

  return async function limitTask<T>(fn: () => Promise<T>): Promise<T> {
    if (limit <= 0) return fn();
    return await new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            runNext();
          });
      });
      runNext();
    });
  };
}

async function readCachedJson<T>(cache: Cache | null, url: string): Promise<T | null> {
  if (!cache) return null;
  try {
    const res = await cache.match(new Request(url, { method: "GET" }));
    if (!res) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function writeCachedJson<T>(
  cache: Cache | null,
  url: string,
  ttlSeconds: number,
  data: T,
): Promise<void> {
  if (!cache) return;
  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttlSeconds}`,
    },
  });
  await cache.put(new Request(url, { method: "GET" }), res);
}

async function fetchEventsPage(
  url: string,
  rateLimit: RateLimitInfo,
): Promise<
  | { ok: true; events: GitHubEvent[]; nextUrl: string | null }
  | { ok: false; error: GitHubErrorInfo }
> {
  const result = await fetchGitHubResponse(url);
  if (!result.ok) {
    updateRateLimit(rateLimit, result.error);
    if (
      result.error.status === 422 &&
      result.error.message?.includes("pagination is limited for this resource")
    ) {
      return { ok: true, events: [], nextUrl: null };
    }
    return { ok: false, error: result.error };
  }

  updateRateLimit(rateLimit, result.meta);
  try {
    const events = (await result.data.json()) as GitHubEvent[];
    const nextUrl = parseNextLink(result.data.headers.get("link"));
    return { ok: true, events, nextUrl };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "unknown",
        status: result.data.status,
        message: err instanceof Error ? err.message : "Invalid JSON response",
        requestId: result.meta.requestId,
      },
    };
  }
}

async function fetchRepoForkStatus(
  repoApiUrl: string,
  memo: Map<string, boolean>,
  cache: Cache | null,
  limiter: ReturnType<typeof createLimiter>,
  rateLimit: RateLimitInfo,
): Promise<boolean> {
  const cached = memo.get(repoApiUrl);
  if (typeof cached === "boolean") return cached;

  const cachedJson = await readCachedJson<RepoApiResponse>(cache, repoApiUrl);
  if (cachedJson) {
    const isFork = cachedJson.fork === true;
    memo.set(repoApiUrl, isFork);
    return isFork;
  }

  const result = await limiter(() => fetchGitHubJson<RepoApiResponse>(repoApiUrl));
  if (!result.ok) {
    updateRateLimit(rateLimit, result.error);
    memo.set(repoApiUrl, false);
    return false;
  }

  updateRateLimit(rateLimit, result.meta);
  const isFork = result.data.fork === true;
  memo.set(repoApiUrl, isFork);
  await writeCachedJson(cache, repoApiUrl, REPO_CACHE_TTL_SECONDS, result.data);
  return isFork;
}

async function fetchPullRequest(
  prApiUrl: string,
  memo: Map<string, PullRequestMemoEntry>,
  cache: Cache | null,
  limiter: ReturnType<typeof createLimiter>,
  rateLimit: RateLimitInfo,
): Promise<{ pr: PullRequestApiResponse | null; error?: GitHubErrorInfo }> {
  const cached = memo.get(prApiUrl);
  if (cached !== undefined) {
    if (cached && typeof cached === "object" && "error" in cached) {
      return { pr: null, error: cached.error };
    }
    return { pr: cached ?? null };
  }

  const cachedJson = await readCachedJson<PullRequestApiResponse>(cache, prApiUrl);
  if (cachedJson) {
    memo.set(prApiUrl, cachedJson);
    return { pr: cachedJson };
  }

  const result = await limiter(() => fetchGitHubJson<PullRequestApiResponse>(prApiUrl));
  if (!result.ok) {
    updateRateLimit(rateLimit, result.error);
    memo.set(prApiUrl, { error: result.error });
    return { pr: null, error: result.error };
  }

  updateRateLimit(rateLimit, result.meta);
  memo.set(prApiUrl, result.data);
  await writeCachedJson(cache, prApiUrl, PR_CACHE_TTL_SECONDS, result.data);
  return { pr: result.data };
}

type PullRequestPayload = {
  title?: string;
  html_url?: string;
  body?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  url?: string;
  number?: number;
};

function extractPullRequestPayload(pr: PullRequestPayload | undefined) {
  const title = typeof pr?.title === "string" ? pr.title.trim() : undefined;
  const htmlUrl = typeof pr?.html_url === "string" ? pr.html_url : undefined;
  const body = typeof pr?.body === "string" ? pr.body : undefined;

  let merged: boolean | undefined;
  if (typeof pr?.merged === "boolean") merged = pr.merged;
  if (merged == null && pr && typeof pr === "object" && "merged_at" in pr) {
    const mergedAt = (pr as { merged_at?: string | null }).merged_at;
    merged = mergedAt != null;
  }

  const apiUrl = typeof pr?.url === "string" ? pr.url : undefined;
  return { title, htmlUrl, body, merged, apiUrl };
}

function resolvePullRequestApiUrl(
  event: GitHubEvent,
  payload: { pull_request?: PullRequestPayload; number?: number },
) {
  if (typeof payload.pull_request?.url === "string") return payload.pull_request.url;
  const prNumber = payload.pull_request?.number ?? payload.number;
  if (typeof prNumber === "number") {
    return `https://api.github.com/repos/${event.repo.name}/pulls/${prNumber}`;
  }
  return null;
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

function needsPullRequestFetch(event: GitHubEvent): string | null {
  if (event.type === "PullRequestEvent") {
    const payload = event.payload as {
      action?: string;
      number?: number;
      pull_request?: PullRequestPayload;
    };
    if (payload.action !== "opened" && payload.action !== "closed" && payload.action !== "reopened")
      return null;
    const prPayload = extractPullRequestPayload(payload.pull_request);
    const needsTitle = !prPayload.title;
    const needsMerged = payload.action === "closed" && prPayload.merged == null;
    if (!needsTitle && !needsMerged) return null;
    return resolvePullRequestApiUrl(event, payload);
  }

  if (event.type === "PullRequestReviewEvent") {
    const payload = event.payload as { action?: string; pull_request?: PullRequestPayload };
    if (payload.action !== "created") return null;
    const prPayload = extractPullRequestPayload(payload.pull_request);
    if (prPayload.title) return null;
    return resolvePullRequestApiUrl(event, payload);
  }

  if (event.type === "PullRequestReviewCommentEvent") {
    const payload = event.payload as { action?: string; pull_request?: PullRequestPayload };
    if (payload.action !== "created") return null;
    const prPayload = extractPullRequestPayload(payload.pull_request);
    if (prPayload.title) return null;
    return resolvePullRequestApiUrl(event, payload);
  }

  return null;
}

async function normalizeEvent(
  event: GitHubEvent,
  context: {
    prMemo: Map<string, PullRequestMemoEntry>;
    cache: Cache | null;
    limiter: ReturnType<typeof createLimiter>;
    rateLimit: RateLimitInfo;
    tracker: ErrorTracker;
  },
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
      pull_request?: PullRequestPayload;
    };
    if (payload.action !== "opened" && payload.action !== "closed" && payload.action !== "reopened")
      return null;

    const prPayload = extractPullRequestPayload(payload.pull_request);
    const prApiUrl = resolvePullRequestApiUrl(event, payload);
    const prNumber = payload.pull_request?.number ?? payload.number;

    let title = prPayload.title;
    let url = prPayload.htmlUrl;
    let summary = summarizeText(prPayload.body);
    let merged = prPayload.merged;

    const needsFetch = !title || (payload.action === "closed" && merged == null);
    if (needsFetch && prApiUrl) {
      const { pr, error } = await fetchPullRequest(
        prApiUrl,
        context.prMemo,
        context.cache,
        context.limiter,
        context.rateLimit,
      );
      if (pr) {
        title = title ?? pr.title?.trim();
        url = url ?? pr.html_url;
        summary = summary ?? summarizeText(pr.body);
        if (merged == null) merged = pr.merged_at != null;
      } else if (error) {
        recordPartial(context.tracker, error);
      }
    }

    const kind =
      payload.action === "opened"
        ? "pull_request_opened"
        : payload.action === "reopened"
          ? "pull_request_reopened"
          : merged
            ? "pull_request_merged"
            : "pull_request_closed";

    if (!url && typeof prNumber === "number") {
      url = pullRequestHtmlUrl(repo.name, prNumber);
    }

    if (!title) {
      const suffix = typeof prNumber === "number" ? ` #${prNumber}` : "";
      title =
        kind === "pull_request_merged"
          ? `Merged pull request${suffix}`
          : payload.action === "opened"
            ? `Opened pull request${suffix}`
            : payload.action === "reopened"
              ? `Reopened pull request${suffix}`
              : payload.action === "closed"
                ? `Closed pull request${suffix}`
                : `Pull request${suffix}`;
    }

    if (!url) return null;

    return {
      ...base,
      kind,
      title,
      url,
      summary,
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
      pull_request?: PullRequestPayload;
      review?: { html_url?: string; body?: string; state?: string };
    };
    if (payload.action !== "created") return null;

    const prPayload = extractPullRequestPayload(payload.pull_request);
    const prApiUrl = resolvePullRequestApiUrl(event, payload);
    const prNumber = payload.pull_request?.number;

    let title = prPayload.title;
    let url = payload.review?.html_url ?? prPayload.htmlUrl;

    if (!title && prApiUrl) {
      const { pr, error } = await fetchPullRequest(
        prApiUrl,
        context.prMemo,
        context.cache,
        context.limiter,
        context.rateLimit,
      );
      if (pr) {
        title = pr.title?.trim();
        url = url ?? pr.html_url;
      } else if (error) {
        recordPartial(context.tracker, error);
      }
    }

    if (!url && typeof prNumber === "number") {
      url = pullRequestHtmlUrl(repo.name, prNumber);
    }

    if (!title) {
      const suffix = typeof prNumber === "number" ? ` #${prNumber}` : "";
      title = `Review on pull request${suffix}`;
    }

    if (!url) return null;

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
      pull_request?: PullRequestPayload;
      comment?: { html_url?: string; body?: string };
    };
    if (payload.action !== "created") return null;

    const prPayload = extractPullRequestPayload(payload.pull_request);
    const prApiUrl = resolvePullRequestApiUrl(event, payload);
    const prNumber = payload.pull_request?.number;

    let title = prPayload.title;
    let url = payload.comment?.html_url ?? prPayload.htmlUrl;

    if (!title && prApiUrl) {
      const { pr, error } = await fetchPullRequest(
        prApiUrl,
        context.prMemo,
        context.cache,
        context.limiter,
        context.rateLimit,
      );
      if (pr) {
        title = pr.title?.trim();
      } else if (error) {
        recordPartial(context.tracker, error);
      }
    }

    if (!url && typeof prNumber === "number") {
      url = pullRequestHtmlUrl(repo.name, prNumber);
    }

    if (!title) {
      const suffix = typeof prNumber === "number" ? ` #${prNumber}` : "";
      title = `Review comment on pull request${suffix}`;
    }

    if (!url) return null;

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
}): Promise<ActivityFetchResult> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100));
  const maxPages = Math.max(1, Math.min(10, options.maxPages ?? 5));

  const items: ActivityItem[] = [];
  const seenUrls = new Set<string>();
  const forkMemo = new Map<string, boolean>();
  const prMemo = new Map<string, PullRequestMemoEntry>();
  const tracker: ErrorTracker = { partial: false };
  const rateLimit: RateLimitInfo = {};
  const cache = typeof caches === "undefined" ? null : caches.default;

  const repoLimiter = createLimiter(CONCURRENCY_LIMIT);
  const prLimiter = createLimiter(CONCURRENCY_LIMIT);

  const firstUrl = new URL(`https://api.github.com/users/${options.username}/events/public`);
  firstUrl.searchParams.set("per_page", String(perPage));
  firstUrl.searchParams.set("page", "1");

  let nextUrl: string | null = firstUrl.toString();
  let pageCount = 0;

  while (nextUrl && pageCount < maxPages) {
    pageCount += 1;

    const pageResult = await fetchEventsPage(nextUrl, rateLimit);
    if (!pageResult.ok) {
      if (items.length > 0) {
        recordPartial(tracker, pageResult.error);
        break;
      }
      throw new GitHubRequestError(pageResult.error);
    }

    const { events, nextUrl: next } = pageResult;
    if (!events.length) break;

    const repoUrls = Array.from(new Set(events.map((event) => event.repo.url)));
    await Promise.all(
      repoUrls.map((repoUrl) =>
        fetchRepoForkStatus(repoUrl, forkMemo, cache, repoLimiter, rateLimit),
      ),
    );

    const candidates = events.filter((event) => !forkMemo.get(event.repo.url));
    const prApiUrls = new Set<string>();

    for (const event of candidates) {
      const prApiUrl = needsPullRequestFetch(event);
      if (prApiUrl) prApiUrls.add(prApiUrl);
    }

    await Promise.all(
      Array.from(prApiUrls).map((prUrl) =>
        fetchPullRequest(prUrl, prMemo, cache, prLimiter, rateLimit),
      ),
    );

    for (const ev of candidates) {
      const item = await normalizeEvent(ev, {
        prMemo,
        cache,
        limiter: prLimiter,
        rateLimit,
        tracker,
      });
      if (!item) continue;

      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      items.push(item);
      if (items.length >= limit) break;
    }

    if (items.length >= limit) break;
    nextUrl = next;
  }

  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const response: ActivityResponse = {
    username: options.username,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, limit),
  };

  if (tracker.partial) {
    response.partial = true;
    if (tracker.errorInfo) response.errorInfo = tracker.errorInfo;
  }

  return { data: response, rateLimit: compactRateLimit(rateLimit) };
}

export async function getRecentActivityPreview(options: {
  username: string;
  limit: number;
  perPage?: number;
}): Promise<ActivityFetchResult> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100));

  const url = new URL(`https://api.github.com/users/${options.username}/events/public`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", "1");

  const rateLimit: RateLimitInfo = {};
  const pageResult = await fetchEventsPage(url.toString(), rateLimit);
  if (!pageResult.ok) {
    throw new GitHubRequestError(pageResult.error);
  }

  const items: ActivityItem[] = [];
  const seenUrls = new Set<string>();

  for (const ev of pageResult.events) {
    const item = normalizeEventPreview(ev);
    if (!item) continue;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    items.push(item);
    if (items.length >= limit) break;
  }

  return {
    data: {
      username: options.username,
      generatedAt: new Date().toISOString(),
      items: items.slice(0, limit),
    },
    rateLimit: compactRateLimit(rateLimit),
  };
}
