import { useEffect, useState } from "react";
import { ActivityList } from "./components/ActivityList";
import type { ActivityErrorInfo, ActivityResponse } from "./lib/activity/types";

type ActivitySource = "preview" | "full";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; detail?: string; errorInfo?: ActivityErrorInfo }
  | { status: "loaded"; data: ActivityResponse; source: ActivitySource };

type Profile = {
  login: string;
  url: string;
  avatarUrl: string;
};

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; profile: Profile };

const ACTIVITY_CACHE_KEY = "activity-cache-v1";

type CachedActivity = {
  data: ActivityResponse;
  cachedAt: string;
  source: ActivitySource;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const ERROR_KINDS = new Set<ActivityErrorInfo["kind"]>([
  "rate_limit",
  "unauthorized",
  "forbidden",
  "not_found",
  "validation",
  "server",
  "network",
  "timeout",
  "unknown",
]);

function isActivityErrorInfo(value: unknown): value is ActivityErrorInfo {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  return typeof kind === "string" && ERROR_KINDS.has(kind as ActivityErrorInfo["kind"]);
}

function isActivityItem(value: unknown): value is ActivityResponse["items"][number] {
  if (!isRecord(value)) return false;
  const actor = value.actor;
  const repo = value.repo;
  return (
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    isRecord(actor) &&
    typeof actor.login === "string" &&
    typeof actor.url === "string" &&
    typeof actor.avatarUrl === "string" &&
    isRecord(repo) &&
    typeof repo.name === "string" &&
    typeof repo.url === "string"
  );
}

function isActivityResponse(value: unknown): value is ActivityResponse {
  if (!isRecord(value)) return false;
  if (typeof value.username !== "string") return false;
  if (typeof value.generatedAt !== "string") return false;
  if (!Array.isArray(value.items)) return false;
  return value.items.every((item) => isActivityItem(item));
}

function isCachedActivity(value: unknown): value is CachedActivity {
  if (!isRecord(value)) return false;
  if (typeof value.cachedAt !== "string") return false;
  if (value.source !== "preview" && value.source !== "full") return false;
  return isActivityResponse(value.data);
}

function parseTimestamp(iso: string) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function isSameActivitySnapshot(next: ActivityResponse, current: ActivityResponse) {
  if (next.items.length !== current.items.length) return false;
  return next.items.every((item, index) => {
    const other = current.items[index];
    if (!other) return false;
    return (
      item.id === other.id &&
      item.kind === other.kind &&
      item.title === other.title &&
      item.url === other.url &&
      item.summary === other.summary &&
      item.reviewState === other.reviewState
    );
  });
}

function shouldApplyActivity(next: ActivityResponse, source: ActivitySource, prev: LoadState) {
  if (prev.status !== "loaded") return true;

  const nextTime = parseTimestamp(next.generatedAt);
  const prevTime = parseTimestamp(prev.data.generatedAt);

  if (prevTime == null && nextTime != null) return true;
  if (nextTime == null && prevTime != null) return false;
  if (nextTime != null && prevTime != null) {
    if (nextTime > prevTime) return true;
    if (nextTime < prevTime) return false;
  }

  if (prev.data.partial !== next.partial) return true;

  if (source === "full" && prev.source !== "full") return true;
  return !isSameActivitySnapshot(next, prev.data);
}

function shouldReplaceCached(
  next: ActivityResponse,
  source: ActivitySource,
  existing: CachedActivity,
) {
  const nextTime = parseTimestamp(next.generatedAt);
  const prevTime = parseTimestamp(existing.data.generatedAt);
  if (prevTime == null) return true;
  if (nextTime == null) return false;
  if (nextTime > prevTime) return true;
  if (nextTime === prevTime && source === "full" && existing.source !== "full") return true;
  return false;
}

function readCachedActivity(): CachedActivity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (isCachedActivity(parsed)) return parsed;
    if (isActivityResponse(parsed)) {
      const value: CachedActivity = {
        data: parsed,
        cachedAt: new Date().toISOString(),
        source: "preview",
      };
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

function writeCachedActivity(data: ActivityResponse, source: ActivitySource) {
  if (typeof window === "undefined") return;
  try {
    const existing = readCachedActivity();
    if (existing && !shouldReplaceCached(data, source, existing)) return;
    const payload: CachedActivity = {
      data,
      cachedAt: new Date().toISOString(),
      source,
    };
    window.localStorage.setItem(ACTIVITY_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore cache write failures (private mode, quota, etc).
  }
}

class ActivityLoadError extends Error {
  detail?: string;
  errorInfo?: ActivityErrorInfo;

  constructor(message: string, detail?: string, errorInfo?: ActivityErrorInfo) {
    super(message);
    this.name = "ActivityLoadError";
    this.detail = detail;
    this.errorInfo = errorInfo;
  }
}

function friendlyErrorMessage(info?: ActivityErrorInfo) {
  switch (info?.kind) {
    case "rate_limit":
      return "GitHub API rate limit reached. Please try again later.";
    case "network":
      return "Network error while contacting GitHub.";
    case "timeout":
      return "GitHub API request timed out.";
    case "server":
      return "GitHub API is temporarily unavailable.";
    case "unauthorized":
    case "forbidden":
      return "GitHub API rejected the request.";
    case "not_found":
      return "GitHub API endpoint was not found.";
    case "validation":
      return "GitHub API rejected the request.";
    default:
      return null;
  }
}

function formatRateLimitReset(reset?: number) {
  if (!reset) return null;
  const d = new Date(reset * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

async function parseErrorResponse(res: Response): Promise<{
  message: string;
  detail?: string;
  errorInfo?: ActivityErrorInfo;
}> {
  const text = await res.text().catch(() => "");
  let message = text || `HTTP ${res.status}`;
  let errorInfo: ActivityErrorInfo | undefined;

  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.message === "string") message = parsed.message;
      if (isActivityErrorInfo(parsed.errorInfo)) errorInfo = parsed.errorInfo;
    } catch {
      // Ignore JSON parse failures.
    }
  }

  const friendly = friendlyErrorMessage(errorInfo);
  if (friendly) {
    return { message: friendly, detail: message, errorInfo };
  }

  return { message, errorInfo };
}

function formatGeneratedAt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short" }).format(d);
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });

  useEffect(() => {
    const cached = readCachedActivity();
    if (cached) {
      setState({ status: "loaded", data: cached.data, source: cached.source });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();

    async function run() {
      try {
        const res = await fetch("/api/profile.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          setProfileState({ status: "error" });
          return;
        }
        const profile = (await res.json()) as Profile;
        if (!profile?.login || !profile?.avatarUrl) {
          setProfileState({ status: "error" });
          return;
        }
        setProfileState({ status: "loaded", profile });
      } catch {
        if (ac.signal.aborted) return;
        setProfileState({ status: "error" });
      }
    }

    void run();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();

    function applyActivity(data: ActivityResponse, source: ActivitySource) {
      if (ac.signal.aborted) return;
      writeCachedActivity(data, source);
      setState((prev) => {
        if (!shouldApplyActivity(data, source, prev)) return prev;
        return { status: "loaded", data, source };
      });
    }

    async function fetchPreview() {
      try {
        const res = await fetch("/api/activity.preview.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as ActivityResponse;
        applyActivity(data, "preview");
      } catch {
        // Ignore preview errors and keep going.
      }
    }

    async function fetchFull() {
      try {
        const res = await fetch("/api/activity.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          const error = await parseErrorResponse(res);
          throw new ActivityLoadError(error.message, error.detail, error.errorInfo);
        }
        const data = (await res.json()) as ActivityResponse;
        applyActivity(data, "full");
      } catch (e) {
        if (ac.signal.aborted) return;
        const cached = readCachedActivity();
        if (cached) {
          setState((prev) =>
            prev.status === "loaded"
              ? prev
              : { status: "loaded", data: cached.data, source: cached.source },
          );
          return;
        }
        const message = e instanceof Error ? e.message : "Unknown error";
        const detail = e instanceof ActivityLoadError ? e.detail : undefined;
        const errorInfo = e instanceof ActivityLoadError ? e.errorInfo : undefined;
        setState((prev) =>
          prev.status === "loaded" ? prev : { status: "error", message, detail, errorInfo },
        );
      }
    }

    void fetchPreview();
    void fetchFull();
    return () => ac.abort();
  }, []);

  const subtitle = "Latest GitHub activities for @JohnTitor";

  const profile = profileState.status === "loaded" ? profileState.profile : null;
  const partialReset =
    state.status === "loaded" ? formatRateLimitReset(state.data.errorInfo?.rateLimitReset) : null;
  const errorReset =
    state.status === "error" ? formatRateLimitReset(state.errorInfo?.rateLimitReset) : null;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(900px_circle_at_15%_5%,rgba(14,165,233,0.12),transparent_45%),radial-gradient(700px_circle_at_85%_0%,rgba(168,85,247,0.10),transparent_40%)] dark:bg-[radial-gradient(900px_circle_at_15%_5%,rgba(14,165,233,0.18),transparent_50%),radial-gradient(700px_circle_at_85%_0%,rgba(168,85,247,0.14),transparent_45%)]" />

      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
        <header className="space-y-6">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <h1 className="mt-3 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
                activity.2k36.org
              </h1>
              <p className="mt-2 break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                {subtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <a
                className="rounded-full border border-zinc-200/70 bg-white/50 px-4 py-2 text-s text-zinc-700 shadow-sm backdrop-blur hover:text-zinc-900 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-300 dark:hover:text-zinc-100"
                href="https://www.2k36.org/en/about"
                target="_blank"
                rel="noreferrer"
              >
                About me
              </a>
              <a
                className="rounded-full border border-zinc-200/70 bg-white/50 px-4 py-2 text-s text-zinc-700 shadow-sm backdrop-blur hover:text-zinc-900 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-300 dark:hover:text-zinc-100"
                href="https://github.com/JohnTitor"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-600 dark:text-zinc-400">
            {profileState.status === "loading" ? (
              <span className="inline-flex items-center gap-3">
                <span className="h-7 w-7 animate-pulse rounded-full bg-zinc-200/80 ring-1 ring-zinc-200/70 dark:bg-zinc-800/70 dark:ring-zinc-800/70" />
                <span className="h-4 w-24 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800/70" />
              </span>
            ) : null}

            {profile ? (
              <a
                className="inline-flex items-center gap-3 no-underline hover:underline"
                href={profile.url}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="h-7 w-7 rounded-full ring-1 ring-zinc-200/70 dark:ring-zinc-800/70"
                  src={profile.avatarUrl}
                  alt={profile.login}
                  loading="lazy"
                />
                <span className="font-mono text-xs sm:text-sm">{profile.login}</span>
              </a>
            ) : null}

            <span className="basis-full h-0" aria-hidden="true" />

            {state.status === "loaded" ? (
              <span className="font-mono text-xs sm:text-sm">
                updated: {formatGeneratedAt(state.data.generatedAt)}
              </span>
            ) : null}
          </div>

          <div className="h-px w-full bg-gradient-to-r from-transparent via-zinc-200/80 to-transparent dark:via-zinc-800/80" />
        </header>

        <main className="mt-10 min-w-0">
          {state.status === "loaded" && state.data.partial ? (
            <div className="mb-6 rounded-2xl border border-amber-200/70 bg-white/50 p-4 text-sm text-zinc-700 shadow-sm backdrop-blur dark:border-amber-900/40 dark:bg-zinc-900/30 dark:text-zinc-300">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                {state.data.errorInfo?.kind === "rate_limit"
                  ? "Showing partial activity due to GitHub API rate limits."
                  : "Showing partial activity due to GitHub API errors."}
              </p>
              {partialReset ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  Rate limit resets at {partialReset}.
                </p>
              ) : null}
            </div>
          ) : null}

          {state.status === "loading" ? (
            <ol className="relative grid min-w-0 grid-cols-1 gap-6 before:absolute before:inset-y-0 before:left-3 before:w-px before:bg-zinc-200/70 before:content-[''] sm:before:left-4 dark:before:bg-zinc-800/70">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="relative min-w-0 pl-8 sm:pl-10">
                  <span
                    className="absolute left-2 top-6 h-3 w-3 rounded-full bg-zinc-300 ring-4 ring-zinc-50 sm:left-2.5 dark:bg-zinc-700 dark:ring-zinc-950"
                    aria-hidden="true"
                  />
                  <div className="animate-pulse rounded-2xl border border-zinc-200/70 bg-white/50 p-4 shadow-sm backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-900/30">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-14 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                      <div className="h-3 w-40 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                    </div>
                    <div className="mt-3 h-5 w-3/4 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                    <div className="mt-2 h-4 w-2/3 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                  </div>
                </li>
              ))}
            </ol>
          ) : null}

          {state.status === "error" ? (
            <div className="space-y-3 rounded-2xl border border-red-200/70 bg-white/50 p-4 text-sm text-zinc-700 shadow-sm backdrop-blur dark:border-red-900/40 dark:bg-zinc-900/30 dark:text-zinc-300">
              <p className="font-medium text-red-700 dark:text-red-300">Failed to load activity</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">{state.message}</p>
              {state.detail ? (
                <p className="break-words font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                  {state.detail}
                </p>
              ) : null}
              {errorReset ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Rate limit resets at {errorReset}.
                </p>
              ) : null}
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                For local development, start the Worker API in another terminal:{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-950/40">
                  pnpm worker:dev
                </code>
              </p>
            </div>
          ) : null}

          {state.status === "loaded" ? <ActivityList items={state.data.items} /> : null}
        </main>

        <footer className="mt-14 flex flex-col items-start gap-2 border-t border-zinc-200/70 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-zinc-800/70 dark:text-zinc-500">
          <p className="font-mono text-[11px]">© 2026 Yuki Okushi. All Rights Reserved.</p>
          <a
            className="inline-flex font-mono text-[11px] underline-offset-2 hover:underline"
            href="https://github.com/JohnTitor/activity.2k36.org"
            target="_blank"
            rel="noreferrer"
          >
            Source code
          </a>
        </footer>
      </div>
    </div>
  );
}
