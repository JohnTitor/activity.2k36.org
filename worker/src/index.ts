type Env = {
  ASSETS: Fetcher
  GITHUB_USERNAME: string
  SITE_DOMAIN: string
  // Optional. Set via `wrangler secret put GITHUB_TOKEN`
  GITHUB_TOKEN?: string
}

import { getRecentActivity, getRecentActivityPreview } from './github/events'
import { activityCacheKey, activityPreviewCacheKey, cacheControlValue, classifyAge, DEFAULT_CACHE_POLICY, profileCacheKey, revalidateLockKey, responseAgeSeconds, withExtraHeaders } from './cache'

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

type GitHubUserApiResponse = {
  login?: string
  html_url?: string
  avatar_url?: string
}

async function fetchGitHubUser(username: string, token?: string) {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'activity.2k36.org',
    'x-github-api-version': '2022-11-28',
  }
  if (token)
    headers.authorization = `Bearer ${token}`

  const res = await fetch(`https://api.github.com/users/${username}`, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = text ? `: ${text.slice(0, 500)}` : ''
    throw new Error(`GitHub API error ${res.status}${detail}`)
  }
  const u = (await res.json()) as GitHubUserApiResponse
  if (!u.login || !u.avatar_url)
    throw new Error('GitHub API error: invalid user response')

  return {
    login: u.login,
    url: u.html_url ?? `https://github.com/${u.login}`,
    avatarUrl: u.avatar_url,
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/api/activity.preview.json') {
      const policy = DEFAULT_CACHE_POLICY
      const cache = caches.default
      const cacheKey = activityPreviewCacheKey(request, env.GITHUB_USERNAME)

      const cached = await cache.match(cacheKey)
      if (cached) {
        const age = responseAgeSeconds(cached)
        const state = classifyAge(age, policy)

        if (state !== 'fresh') {
          const lockKey = revalidateLockKey(request, '/api/activity.preview.json', env.GITHUB_USERNAME)
          const lock = await cache.match(lockKey)
          const lockAge = lock ? responseAgeSeconds(lock) : null

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString()
            await cache.put(lockKey, new Response('1', { headers: { 'x-generated-at': now } }))
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await getRecentActivityPreview({
                    username: env.GITHUB_USERNAME,
                    token: env.GITHUB_TOKEN,
                    limit: 30,
                  })
                  const freshRes = json(fresh, {
                    status: 200,
                    headers: {
                      'cache-control': cacheControlValue(policy),
                      'x-generated-at': fresh.generatedAt,
                    },
                  })
                  await cache.put(cacheKey, freshRes.clone())
                }
                catch {
                  // Keep serving cached response.
                }
              })(),
            )
          }
        }

        return withExtraHeaders(cached, {
          'cache-control': cacheControlValue(policy),
          'x-cache': state === 'fresh' ? 'HIT' : 'STALE',
        })
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await getRecentActivityPreview({
          username: env.GITHUB_USERNAME,
          token: env.GITHUB_TOKEN,
          limit: 30,
        })
        const res = json(fresh, {
          status: 200,
          headers: {
            'cache-control': cacheControlValue(policy),
            'x-generated-at': fresh.generatedAt,
          },
        })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        return withExtraHeaders(res, { 'x-cache': 'MISS' })
      }
      catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return json({ error: 'upstream_error', message }, { status: 502 })
      }
    }

    if (url.pathname === '/api/profile.json') {
      const policy = DEFAULT_CACHE_POLICY
      const cache = caches.default
      const cacheKey = profileCacheKey(request, env.GITHUB_USERNAME)

      const cached = await cache.match(cacheKey)
      if (cached) {
        const age = responseAgeSeconds(cached)
        const state = classifyAge(age, policy)

        if (state !== 'fresh') {
          const lockKey = revalidateLockKey(request, '/api/profile.json', env.GITHUB_USERNAME)
          const lock = await cache.match(lockKey)
          const lockAge = lock ? responseAgeSeconds(lock) : null

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString()
            await cache.put(lockKey, new Response('1', { headers: { 'x-generated-at': now } }))
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await fetchGitHubUser(env.GITHUB_USERNAME, env.GITHUB_TOKEN)
                  const freshRes = json(fresh, {
                    status: 200,
                    headers: {
                      'cache-control': cacheControlValue(policy),
                      'x-generated-at': new Date().toISOString(),
                    },
                  })
                  await cache.put(cacheKey, freshRes.clone())
                }
                catch {
                  // Keep serving cached response.
                }
              })(),
            )
          }
        }

        return withExtraHeaders(cached, {
          'cache-control': cacheControlValue(policy),
          'x-cache': state === 'fresh' ? 'HIT' : 'STALE',
        })
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await fetchGitHubUser(env.GITHUB_USERNAME, env.GITHUB_TOKEN)
        const now = new Date().toISOString()
        const res = json(fresh, {
          status: 200,
          headers: {
            'cache-control': cacheControlValue(policy),
            'x-generated-at': now,
          },
        })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        return withExtraHeaders(res, { 'x-cache': 'MISS' })
      }
      catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return json({ error: 'upstream_error', message }, { status: 502 })
      }
    }

    if (url.pathname === '/api/activity.json') {
      const policy = DEFAULT_CACHE_POLICY
      const cache = caches.default
      const cacheKey = activityCacheKey(request, env.GITHUB_USERNAME)

      const cached = await cache.match(cacheKey)
      if (cached) {
        const age = responseAgeSeconds(cached)
        const state = classifyAge(age, policy)

        if (state !== 'fresh') {
          const lockKey = revalidateLockKey(request, '/api/activity.json', env.GITHUB_USERNAME)
          const lock = await cache.match(lockKey)
          const lockAge = lock ? responseAgeSeconds(lock) : null

          // Prevent stampedes: allow at most one refresh per ~15s per PoP.
          if (lockAge == null || lockAge > 15) {
            const now = new Date().toISOString()
            await cache.put(lockKey, new Response('1', { headers: { 'x-generated-at': now } }))
            ctx.waitUntil(
              (async () => {
                try {
                  const fresh = await getRecentActivity({
                    username: env.GITHUB_USERNAME,
                    token: env.GITHUB_TOKEN,
                    limit: 30,
                  })
                  const freshRes = json(fresh, {
                    status: 200,
                    headers: {
                      'cache-control': cacheControlValue(policy),
                      'x-generated-at': fresh.generatedAt,
                    },
                  })
                  await cache.put(cacheKey, freshRes.clone())
                }
                catch {
                  // Keep serving cached response.
                }
              })(),
            )
          }
        }

        return withExtraHeaders(cached, {
          'cache-control': cacheControlValue(policy),
          'x-cache': state === 'fresh' ? 'HIT' : 'STALE',
        })
      }

      // Cache miss: fetch synchronously.
      try {
        const fresh = await getRecentActivity({
          username: env.GITHUB_USERNAME,
          token: env.GITHUB_TOKEN,
          limit: 30,
        })
        const res = json(fresh, {
          status: 200,
          headers: {
            'cache-control': cacheControlValue(policy),
            'x-generated-at': fresh.generatedAt,
          },
        })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        return withExtraHeaders(res, { 'x-cache': 'MISS' })
      }
      catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        return json({ error: 'upstream_error', message }, { status: 502 })
      }
    }

    const res = await env.ASSETS.fetch(request)
    if (res.status !== 404)
      return res

    // SPA fallback
    const fallbackUrl = new URL('/index.html', request.url)
    return env.ASSETS.fetch(new Request(fallbackUrl, request))
  },
} satisfies ExportedHandler<Env>
