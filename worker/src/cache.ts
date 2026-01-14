export type CachePolicy = {
  maxAgeSeconds: number
  staleWhileRevalidateSeconds: number
}

export const DEFAULT_CACHE_POLICY: CachePolicy = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 300,
}

export function cacheControlValue(policy: CachePolicy) {
  return `public, max-age=${policy.maxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`
}

export function activityCacheKey(request: Request, username: string) {
  const url = new URL(request.url)
  url.pathname = '/api/activity.json'
  url.search = ''
  url.searchParams.set('username', username)
  url.searchParams.set('v', '1')
  return new Request(url.toString(), { method: 'GET' })
}

export function activityPreviewCacheKey(request: Request, username: string) {
  const url = new URL(request.url)
  url.pathname = '/api/activity.preview.json'
  url.search = ''
  url.searchParams.set('username', username)
  url.searchParams.set('v', '1')
  return new Request(url.toString(), { method: 'GET' })
}

export function profileCacheKey(request: Request, username: string) {
  const url = new URL(request.url)
  url.pathname = '/api/profile.json'
  url.search = ''
  url.searchParams.set('username', username)
  url.searchParams.set('v', '1')
  return new Request(url.toString(), { method: 'GET' })
}

export function revalidateLockKey(request: Request, pathname: string, username: string) {
  const url = new URL(request.url)
  url.pathname = pathname
  url.search = ''
  url.searchParams.set('username', username)
  url.searchParams.set('lock', '1')
  url.searchParams.set('v', '1')
  return new Request(url.toString(), { method: 'GET' })
}

export function responseAgeSeconds(res: Response) {
  const generatedAt = res.headers.get('x-generated-at')
  if (!generatedAt)
    return null
  const t = Date.parse(generatedAt)
  if (Number.isNaN(t))
    return null
  return (Date.now() - t) / 1000
}

export function classifyAge(ageSeconds: number | null, policy: CachePolicy) {
  if (ageSeconds == null)
    return 'stale' as const
  if (ageSeconds <= policy.maxAgeSeconds)
    return 'fresh' as const
  if (ageSeconds <= policy.maxAgeSeconds + policy.staleWhileRevalidateSeconds)
    return 'stale' as const
  return 'expired' as const
}

export function withExtraHeaders(res: Response, extra: Record<string, string>) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(extra))
    headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
