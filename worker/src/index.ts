type Env = {
  ASSETS: Fetcher;
  GITHUB_USERNAME: string;
  SITE_DOMAIN: string;
};

import { getRecentActivity, getRecentActivityPreview } from "./github/events";
import { fetchGitHubJson, GitHubRequestError } from "./github/client";
import {
  activityCacheKey,
  activityPreviewCacheKey,
  cacheControlValue,
  classifyAge,
  DEFAULT_CACHE_POLICY,
  ogCacheKey,
  profileCacheKey,
  readRateLimitReset,
  revalidateLockKey,
  responseAgeSeconds,
  writeRateLimitReset,
  withExtraHeaders,
} from "./cache";
import { renderOgSvg } from "./og";

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

type GitHubUserApiResponse = {
  login?: string;
  html_url?: string;
  avatar_url?: string;
};

type RateLimitInfo = {
  remaining?: number;
  reset?: number;
};

function rateLimitHeaders(rateLimit?: RateLimitInfo) {
  if (!rateLimit) return {};
  const headers: Record<string, string> = {};
  if (rateLimit.remaining != null) headers["x-rate-limit-remaining"] = String(rateLimit.remaining);
  if (rateLimit.reset != null) headers["x-rate-limit-reset"] = String(rateLimit.reset);
  return headers;
}

async function fetchGitHubUser(username: string) {
  const result = await fetchGitHubJson<GitHubUserApiResponse>(
    `https://api.github.com/users/${username}`,
  );
  if (!result.ok) throw new GitHubRequestError(result.error);

  const u = result.data;
  if (!u.login || !u.avatar_url) {
    throw new GitHubRequestError({
      kind: "unknown",
      message: "GitHub API error: invalid user response",
      requestId: result.meta.requestId,
    });
  }

  return {
    profile: {
      login: u.login,
      url: u.html_url ?? `https://github.com/${u.login}`,
      avatarUrl: u.avatar_url,
    },
    rateLimit: {
      remaining: result.meta.rateLimitRemaining,
      reset: result.meta.rateLimitReset,
    } satisfies RateLimitInfo,
  };
}

async function getActiveRateLimitReset(
  cache: Cache,
  request: Request,
  username: string,
): Promise<number | null> {
  const reset = await readRateLimitReset(cache, request, username);
  if (!reset) return null;
  const now = Math.floor(Date.now() / 1000);
  return reset > now ? reset : null;
}

async function storeRateLimitReset(
  cache: Cache,
  request: Request,
  username: string,
  reset?: number,
) {
  if (!reset) return;
  await writeRateLimitReset(cache, request, username, reset);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/og.svg") {
      const bypassCache =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.searchParams.has("nocache");
      const cache = caches.default;
      const cacheKey = ogCacheKey(request, env.GITHUB_USERNAME, env.SITE_DOMAIN);

      if (!bypassCache) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          return withExtraHeaders(cached, {
            "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
            "x-cache": "HIT",
          });
        }
      }

      try {
        const svg = await renderOgSvg({
          username: env.GITHUB_USERNAME,
          domain: env.SITE_DOMAIN,
        });
        const cacheControl = bypassCache
          ? "no-store"
          : "public, max-age=86400, stale-while-revalidate=604800";
        const res = new Response(svg, {
          status: 200,
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": cacheControl,
          },
        });
        if (!bypassCache) {
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
        }
        return withExtraHeaders(res, { "x-cache": bypassCache ? "BYPASS" : "MISS" });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        return json({ error: "upstream_error", message }, { status: 502 });
      }
    }

    if (url.pathname === "/api/activity.preview.json") {
      const policy = DEFAULT_CACHE_POLICY;
      const cache = caches.default;
      const cacheKey = activityPreviewCacheKey(request, env.GITHUB_USERNAME);

      const cached = await cache.match(cacheKey);
      if (cached) {
        const age = responseAgeSeconds(cached);
        const state = classifyAge(age, policy);
        let activeReset: number | null = null;

        if (state !== "fresh") {
          activeReset = await getActiveRateLimitReset(cache, request, env.GITHUB_USERNAME);
          if (activeReset) {
            return withExtraHeaders(cached, {
              "cache-control": cacheControlValue(policy),
              "x-cache": "STALE",
              "x-rate-limit-reset": String(activeReset),
            });
          }

          const lockKey = revalidateLockKey(
            request,
            "/api/activity.preview.json",
            env.GITHUB_USERNAME,
          );
          const lock = await cache.match(lockKey);
          const lockAge = lock ? responseAgeSeconds(lock) : null;

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString();
            await cache.put(lockKey, new Response("1", { headers: { "x-generated-at": now } }));
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await getRecentActivityPreview({
                    username: env.GITHUB_USERNAME,
                    limit: 20,
                  });
                  const freshRes = json(fresh.data, {
                    status: 200,
                    headers: {
                      "cache-control": cacheControlValue(policy),
                      "x-generated-at": fresh.data.generatedAt,
                      ...rateLimitHeaders(fresh.rateLimit),
                    },
                  });
                  if (fresh.data.errorInfo?.kind === "rate_limit") {
                    await storeRateLimitReset(
                      cache,
                      request,
                      env.GITHUB_USERNAME,
                      fresh.data.errorInfo.rateLimitReset,
                    );
                  }
                  await cache.put(cacheKey, freshRes.clone());
                } catch (e) {
                  if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
                    await storeRateLimitReset(
                      cache,
                      request,
                      env.GITHUB_USERNAME,
                      e.info.rateLimitReset,
                    );
                  }
                  // Keep serving cached response.
                }
              })(),
            );
          }
        }

        return withExtraHeaders(cached, {
          "cache-control": cacheControlValue(policy),
          "x-cache": state === "fresh" ? "HIT" : "STALE",
          ...(activeReset ? { "x-rate-limit-reset": String(activeReset) } : {}),
        });
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await getRecentActivityPreview({
          username: env.GITHUB_USERNAME,
          limit: 20,
        });
        const res = json(fresh.data, {
          status: 200,
          headers: {
            "cache-control": cacheControlValue(policy),
            "x-generated-at": fresh.data.generatedAt,
            ...rateLimitHeaders(fresh.rateLimit),
          },
        });
        if (fresh.data.errorInfo?.kind === "rate_limit") {
          await storeRateLimitReset(
            cache,
            request,
            env.GITHUB_USERNAME,
            fresh.data.errorInfo.rateLimitReset,
          );
        }
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return withExtraHeaders(res, { "x-cache": "MISS" });
      } catch (e) {
        if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
          await storeRateLimitReset(cache, request, env.GITHUB_USERNAME, e.info.rateLimitReset);
        }
        const message = e instanceof Error ? e.message : "Unknown error";
        const errorInfo = e instanceof GitHubRequestError ? e.info : undefined;
        return json(
          { error: "upstream_error", message, errorInfo },
          {
            status: 502,
            headers: rateLimitHeaders(errorInfo ? { reset: errorInfo.rateLimitReset } : undefined),
          },
        );
      }
    }

    if (url.pathname === "/api/profile.json") {
      const policy = DEFAULT_CACHE_POLICY;
      const cache = caches.default;
      const cacheKey = profileCacheKey(request, env.GITHUB_USERNAME);

      const cached = await cache.match(cacheKey);
      if (cached) {
        const age = responseAgeSeconds(cached);
        const state = classifyAge(age, policy);
        let activeReset: number | null = null;

        if (state !== "fresh") {
          activeReset = await getActiveRateLimitReset(cache, request, env.GITHUB_USERNAME);
          if (activeReset) {
            return withExtraHeaders(cached, {
              "cache-control": cacheControlValue(policy),
              "x-cache": "STALE",
              "x-rate-limit-reset": String(activeReset),
            });
          }

          const lockKey = revalidateLockKey(request, "/api/profile.json", env.GITHUB_USERNAME);
          const lock = await cache.match(lockKey);
          const lockAge = lock ? responseAgeSeconds(lock) : null;

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString();
            await cache.put(lockKey, new Response("1", { headers: { "x-generated-at": now } }));
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await fetchGitHubUser(env.GITHUB_USERNAME);
                  const freshRes = json(fresh.profile, {
                    status: 200,
                    headers: {
                      "cache-control": cacheControlValue(policy),
                      "x-generated-at": new Date().toISOString(),
                      ...rateLimitHeaders(fresh.rateLimit),
                    },
                  });
                  await cache.put(cacheKey, freshRes.clone());
                } catch (e) {
                  if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
                    await storeRateLimitReset(
                      cache,
                      request,
                      env.GITHUB_USERNAME,
                      e.info.rateLimitReset,
                    );
                  }
                  // Keep serving cached response.
                }
              })(),
            );
          }
        }

        return withExtraHeaders(cached, {
          "cache-control": cacheControlValue(policy),
          "x-cache": state === "fresh" ? "HIT" : "STALE",
          ...(activeReset ? { "x-rate-limit-reset": String(activeReset) } : {}),
        });
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await fetchGitHubUser(env.GITHUB_USERNAME);
        const now = new Date().toISOString();
        const res = json(fresh.profile, {
          status: 200,
          headers: {
            "cache-control": cacheControlValue(policy),
            "x-generated-at": now,
            ...rateLimitHeaders(fresh.rateLimit),
          },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return withExtraHeaders(res, { "x-cache": "MISS" });
      } catch (e) {
        if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
          await storeRateLimitReset(cache, request, env.GITHUB_USERNAME, e.info.rateLimitReset);
        }
        const message = e instanceof Error ? e.message : "Unknown error";
        const errorInfo = e instanceof GitHubRequestError ? e.info : undefined;
        return json(
          { error: "upstream_error", message, errorInfo },
          {
            status: 502,
            headers: rateLimitHeaders(errorInfo ? { reset: errorInfo.rateLimitReset } : undefined),
          },
        );
      }
    }

    if (url.pathname === "/api/activity.json") {
      const policy = DEFAULT_CACHE_POLICY;
      const cache = caches.default;
      const cacheKey = activityCacheKey(request, env.GITHUB_USERNAME);

      const cached = await cache.match(cacheKey);
      if (cached) {
        const age = responseAgeSeconds(cached);
        const state = classifyAge(age, policy);
        let activeReset: number | null = null;

        if (state !== "fresh") {
          activeReset = await getActiveRateLimitReset(cache, request, env.GITHUB_USERNAME);
          if (activeReset) {
            return withExtraHeaders(cached, {
              "cache-control": cacheControlValue(policy),
              "x-cache": "STALE",
              "x-rate-limit-reset": String(activeReset),
            });
          }

          const lockKey = revalidateLockKey(request, "/api/activity.json", env.GITHUB_USERNAME);
          const lock = await cache.match(lockKey);
          const lockAge = lock ? responseAgeSeconds(lock) : null;

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString();
            await cache.put(lockKey, new Response("1", { headers: { "x-generated-at": now } }));
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await getRecentActivity({
                    username: env.GITHUB_USERNAME,
                    limit: 20,
                  });
                  const freshRes = json(fresh.data, {
                    status: 200,
                    headers: {
                      "cache-control": cacheControlValue(policy),
                      "x-generated-at": fresh.data.generatedAt,
                      ...rateLimitHeaders(fresh.rateLimit),
                    },
                  });
                  if (fresh.data.errorInfo?.kind === "rate_limit") {
                    await storeRateLimitReset(
                      cache,
                      request,
                      env.GITHUB_USERNAME,
                      fresh.data.errorInfo.rateLimitReset,
                    );
                  }
                  await cache.put(cacheKey, freshRes.clone());
                } catch (e) {
                  if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
                    await storeRateLimitReset(
                      cache,
                      request,
                      env.GITHUB_USERNAME,
                      e.info.rateLimitReset,
                    );
                  }
                  // Keep serving cached response.
                }
              })(),
            );
          }
        }

        return withExtraHeaders(cached, {
          "cache-control": cacheControlValue(policy),
          "x-cache": state === "fresh" ? "HIT" : "STALE",
          ...(activeReset ? { "x-rate-limit-reset": String(activeReset) } : {}),
        });
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await getRecentActivity({
          username: env.GITHUB_USERNAME,
          limit: 20,
        });
        const res = json(fresh.data, {
          status: 200,
          headers: {
            "cache-control": cacheControlValue(policy),
            "x-generated-at": fresh.data.generatedAt,
            ...rateLimitHeaders(fresh.rateLimit),
          },
        });
        if (fresh.data.errorInfo?.kind === "rate_limit") {
          await storeRateLimitReset(
            cache,
            request,
            env.GITHUB_USERNAME,
            fresh.data.errorInfo.rateLimitReset,
          );
        }
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return withExtraHeaders(res, { "x-cache": "MISS" });
      } catch (e) {
        if (e instanceof GitHubRequestError && e.info.kind === "rate_limit") {
          await storeRateLimitReset(cache, request, env.GITHUB_USERNAME, e.info.rateLimitReset);
        }
        const message = e instanceof Error ? e.message : "Unknown error";
        const errorInfo = e instanceof GitHubRequestError ? e.info : undefined;
        return json(
          { error: "upstream_error", message, errorInfo },
          {
            status: 502,
            headers: rateLimitHeaders(errorInfo ? { reset: errorInfo.rateLimitReset } : undefined),
          },
        );
      }
    }

    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    // SPA fallback
    const fallbackUrl = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  },
} satisfies ExportedHandler<Env>;
