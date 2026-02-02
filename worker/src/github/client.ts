export type GitHubErrorKind =
  | "rate_limit"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

export type GitHubErrorInfo = {
  kind: GitHubErrorKind;
  status?: number;
  retryAfter?: number;
  rateLimitReset?: number;
  requestId?: string;
  message?: string;
};

export type GitHubResponseMeta = {
  requestId?: string;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
};

export type GitHubResult<T> =
  | { ok: true; data: T; meta: GitHubResponseMeta }
  | { ok: false; error: GitHubErrorInfo };

export type GitHubRequestOptions = {
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  retryMaxDelayMs?: number;
  retryMaxAfterMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 2000;
const DEFAULT_RETRY_MAX_AFTER_MS = 1000;

export class GitHubRequestError extends Error {
  info: GitHubErrorInfo;

  constructor(info: GitHubErrorInfo) {
    super(info.message ?? "GitHub API request failed");
    this.name = "GitHubRequestError";
    this.info = info;
  }
}

function ghHeaders() {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "activity.2k36.org",
    "x-github-api-version": "2022-11-28",
  };
  return headers;
}

function parseNumberHeader(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseRetryAfter(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function extractMeta(headers: Headers): GitHubResponseMeta {
  return {
    requestId: headers.get("x-github-request-id") ?? undefined,
    rateLimitRemaining: parseNumberHeader(headers, "x-ratelimit-remaining"),
    rateLimitReset: parseNumberHeader(headers, "x-ratelimit-reset"),
  };
}

function parseErrorMessage(text: string) {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Ignore JSON parse failures.
  }
  return text;
}

function isRateLimitMessage(message: string | undefined) {
  if (!message) return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("rate limit") ||
    lowered.includes("secondary rate limit") ||
    lowered.includes("abuse detection")
  );
}

function classifyErrorKind(
  status: number | undefined,
  message: string | undefined,
): GitHubErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403 && isRateLimitMessage(message)) return "rate_limit";
  if (status === 429) return "rate_limit";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (typeof status === "number" && status >= 500) return "server";
  return "unknown";
}

function shouldRetryError(info: GitHubErrorInfo) {
  if (info.kind === "network" || info.kind === "timeout" || info.kind === "server") return true;
  if (info.kind === "rate_limit") return true;
  return false;
}

function computeBackoffMs(attempt: number, options: GitHubRequestOptions, retryAfter?: number) {
  const maxAfter = options.retryMaxAfterMs ?? DEFAULT_RETRY_MAX_AFTER_MS;
  if (retryAfter != null) {
    const delay = retryAfter * 1000;
    return delay > maxAfter ? null : delay;
  }
  const base = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const maxDelay = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const exp = Math.min(base * 2 ** Math.max(0, attempt - 1), maxDelay);
  const jitter = Math.random() * 100;
  return exp + jitter;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchGitHubResponse(
  url: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubResult<Response>> {
  const retries = options.retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response | null = null;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutId = timeoutMs
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

    try {
      res = await fetch(url, { headers: ghHeaders(), signal: controller.signal });
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        const info: GitHubErrorInfo = { kind: "timeout", message: "GitHub API request timed out" };
        if (attempt < retries && shouldRetryError(info)) {
          const backoff = computeBackoffMs(attempt, options);
          if (backoff != null) {
            await delay(backoff);
            continue;
          }
        }
        return { ok: false, error: info };
      }
      const info: GitHubErrorInfo = {
        kind: "network",
        message: err instanceof Error ? err.message : "Network error",
      };
      if (attempt < retries && shouldRetryError(info)) {
        const backoff = computeBackoffMs(attempt, options);
        if (backoff != null) {
          await delay(backoff);
          continue;
        }
      }
      return { ok: false, error: info };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const meta = extractMeta(res.headers);

    if (res.ok) {
      return { ok: true, data: res, meta };
    }

    const text = await res.text().catch(() => "");
    const message = parseErrorMessage(text);
    const retryAfter = parseRetryAfter(res.headers);
    const info: GitHubErrorInfo = {
      kind: classifyErrorKind(res.status, message),
      status: res.status,
      retryAfter,
      rateLimitReset: meta.rateLimitReset,
      requestId: meta.requestId,
      message: message ? message.slice(0, 200) : undefined,
    };

    if (attempt < retries && shouldRetryError(info)) {
      const backoff = computeBackoffMs(attempt, options, info.retryAfter);
      if (backoff != null) {
        await delay(backoff);
        continue;
      }
    }

    return { ok: false, error: info };
  }

  return { ok: false, error: { kind: "unknown", message: "GitHub API request failed" } };
}

export async function fetchGitHubJson<T>(
  url: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubResult<T>> {
  const result = await fetchGitHubResponse(url, options);
  if (!result.ok) return result;

  try {
    const data = (await result.data.json()) as T;
    return { ok: true, data, meta: result.meta };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "unknown",
        status: result.data.status,
        requestId: result.meta.requestId,
        message: err instanceof Error ? err.message : "Invalid JSON response",
      },
    };
  }
}
