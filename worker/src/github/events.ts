import type { ActivityItem, ActivityResponse, PullRequestReviewState } from '../activity/types'

type GitHubEvent = {
  id: string
  type: string
  actor: {
    login: string
    url: string
    avatar_url: string
  }
  repo: {
    name: string
    url: string
  }
  payload: unknown
  created_at: string
}

type GitHubApiOptions = {
  token?: string
}

function ghHeaders({ token }: GitHubApiOptions) {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'activity.2k36.org',
    'x-github-api-version': '2022-11-28',
  }
  if (token)
    headers.authorization = `Bearer ${token}`
  return headers
}

async function fetchGitHubGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GitHubApiOptions,
): Promise<T> {
  if (!options.token)
    throw new Error('Missing GITHUB_TOKEN for GitHub GraphQL API')

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...ghHeaders(options),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    const detail = text ? `: ${text.slice(0, 500)}` : ''
    throw new Error(`GitHub GraphQL error ${res.status}${detail}`)
  }

  const json = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> }
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).filter(Boolean).join(' | ') || 'Unknown GraphQL error'
    throw new Error(`GitHub GraphQL error: ${msg}`)
  }
  if (!json.data)
    throw new Error('GitHub GraphQL error: missing data')

  return json.data
}

async function fetchGitHubJson<T>(url: string, options: GitHubApiOptions): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders(options) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = text ? `: ${text.slice(0, 500)}` : ''
    throw new Error(`GitHub API error ${res.status}${detail}`)
  }
  return (await res.json()) as T
}

type RepoApiResponse = {
  fork?: boolean
}

type PullRequestApiResponse = {
  html_url?: string
  title?: string
  body?: string | null
  merged_at?: string | null
}

function repoHtmlUrl(repoName: string) {
  return `https://github.com/${repoName}`
}

function userHtmlUrl(login: string) {
  return `https://github.com/${login}`
}

function pullRequestHtmlUrl(repoName: string, number: number) {
  return `https://github.com/${repoName}/pull/${number}`
}

function summarizeText(input: unknown, maxLen = 160) {
  if (typeof input !== 'string')
    return undefined
  const s = input.replaceAll('\r\n', '\n').replaceAll('\n', ' ').replaceAll(/\s+/g, ' ').trim()
  if (!s)
    return undefined
  if (s.length <= maxLen)
    return s
  return `${s.slice(0, maxLen - 1).trimEnd()}…`
}

function reviewStateFromGitHub(input: unknown): PullRequestReviewState {
  if (typeof input !== 'string')
    return 'unknown'
  switch (input.toLowerCase()) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes_requested'
    case 'commented':
      return 'commented'
    case 'dismissed':
      return 'dismissed'
    case 'pending':
      return 'pending'
    default:
      return 'unknown'
  }
}

function branchFromRef(ref: unknown) {
  if (typeof ref !== 'string')
    return undefined
  const prefix = 'refs/heads/'
  if (ref.startsWith(prefix))
    return ref.slice(prefix.length)
  return ref
}

function normalizeEventPreview(event: GitHubEvent): ActivityItem | null {
  const actor = {
    login: event.actor.login,
    url: userHtmlUrl(event.actor.login),
    avatarUrl: event.actor.avatar_url,
  }
  const repo = {
    name: event.repo.name,
    url: repoHtmlUrl(event.repo.name),
  }

  const base = {
    id: event.id,
    createdAt: event.created_at,
    actor,
    repo,
  }

  if (event.type === 'IssuesEvent') {
    const payload = event.payload as { action?: string; issue?: { html_url?: string; title?: string; body?: string } }
    if (payload.action !== 'opened')
      return null
    const title = payload.issue?.title?.trim()
    const url = payload.issue?.html_url
    if (!title || !url)
      return null
    return {
      ...base,
      kind: 'issue_opened',
      title,
      url,
      summary: summarizeText(payload.issue?.body),
    }
  }

  if (event.type === 'PullRequestEvent') {
    const payload = event.payload as {
      action?: string
      number?: number
      pull_request?: { number?: number }
    }
    if (payload.action !== 'opened' && payload.action !== 'closed' && payload.action !== 'reopened')
      return null

    const prNumber = payload.pull_request?.number ?? payload.number
    if (typeof prNumber !== 'number')
      return null

    const title = payload.action === 'opened'
      ? `Opened pull request #${prNumber}`
      : payload.action === 'reopened'
        ? `Reopened pull request #${prNumber}`
        : `Closed pull request #${prNumber}`

    return {
      ...base,
      kind: payload.action === 'opened'
        ? 'pull_request_opened'
        : payload.action === 'reopened'
          ? 'pull_request_reopened'
          : 'pull_request_closed',
      title,
      url: pullRequestHtmlUrl(repo.name, prNumber),
    }
  }

  if (event.type === 'IssueCommentEvent') {
    const payload = event.payload as {
      action?: string
      issue?: { title?: string }
      comment?: { html_url?: string; body?: string }
    }
    if (payload.action !== 'created')
      return null
    const title = payload.issue?.title?.trim()
    const url = payload.comment?.html_url
    if (!title || !url)
      return null
    return {
      ...base,
      kind: 'issue_or_pr_comment',
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    }
  }

  if (event.type === 'PullRequestReviewEvent') {
    const payload = event.payload as {
      action?: string
      pull_request?: { number?: number }
      review?: { html_url?: string; body?: string; state?: string }
    }
    if (payload.action !== 'created')
      return null

    const prNumber = payload.pull_request?.number
    if (typeof prNumber !== 'number')
      return null

    const reviewState = reviewStateFromGitHub(payload.review?.state)
    const summary = summarizeText(payload.review?.body)
    if (reviewState === 'commented' && !summary)
      return null

    return {
      ...base,
      kind: 'pull_request_review',
      title: `Review on pull request #${prNumber}`,
      url: payload.review?.html_url ?? pullRequestHtmlUrl(repo.name, prNumber),
      reviewState,
      summary,
    }
  }

  if (event.type === 'PullRequestReviewCommentEvent') {
    const payload = event.payload as {
      action?: string
      pull_request?: { number?: number }
      comment?: { html_url?: string; body?: string }
    }
    if (payload.action !== 'created')
      return null

    const prNumber = payload.pull_request?.number
    const url = payload.comment?.html_url
    if (typeof prNumber !== 'number' || !url)
      return null

    return {
      ...base,
      kind: 'pull_request_review_comment',
      title: `Review comment on pull request #${prNumber}`,
      url,
      summary: summarizeText(payload.comment?.body),
    }
  }

  if (event.type === 'ReleaseEvent') {
    const payload = event.payload as {
      action?: string
      release?: { html_url?: string; name?: string; tag_name?: string; body?: string }
    }
    if (payload.action !== 'published')
      return null
    const titleRaw = payload.release?.name?.trim() || payload.release?.tag_name?.trim()
    const url = payload.release?.html_url
    if (!titleRaw || !url)
      return null
    return {
      ...base,
      kind: 'release_published',
      title: titleRaw,
      url,
      summary: summarizeText(payload.release?.body),
    }
  }

  return null
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader)
    return null
  // Example:
  // <https://api.github.com/user/123/events?page=2>; rel="next", <...>; rel="last"
  const parts = linkHeader.split(',')
  for (const part of parts) {
    const [rawUrl, ...params] = part.trim().split(';').map(s => s.trim())
    const rel = params.find(p => p.startsWith('rel='))
    if (rel && rel.includes('"next"')) {
      const m = rawUrl.match(/^<(.+)>$/)
      return m?.[1] ?? null
    }
  }
  return null
}

async function fetchEventsPage(url: string, options: GitHubApiOptions): Promise<{ events: GitHubEvent[]; nextUrl: string | null }> {
  const res = await fetch(url, { headers: ghHeaders(options) })
  if (res.status === 422) {
    const text = await res.text().catch(() => '')
    // GitHub sometimes returns 422 for deep pagination:
    // {"message":"In order to keep the API fast for everyone, pagination is limited for this resource.", ...}
    if (text.includes('pagination is limited for this resource')) {
      return { events: [], nextUrl: null }
    }
    throw new Error(`GitHub API error 422: ${text.slice(0, 500)}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = text ? `: ${text.slice(0, 500)}` : ''
    throw new Error(`GitHub API error ${res.status}${detail}`)
  }
  const events = (await res.json()) as GitHubEvent[]
  const nextUrl = parseNextLink(res.headers.get('link'))
  return { events, nextUrl }
}

type PrSearchNode = {
  id: string
  title: string
  url: string
  createdAt: string
  state: 'OPEN' | 'CLOSED' | string
  mergedAt: string | null
  bodyText: string
  repository: {
    nameWithOwner: string
    url: string
    isFork: boolean
  }
  author: {
    login: string
    url: string
    avatarUrl: string
  } | null
}

async function searchPullRequestsGraphQL(options: {
  username: string
  token: string
  first: number
}): Promise<ActivityItem[]> {
  const q = `is:pr author:${options.username} sort:created-desc`

  const data = await fetchGitHubGraphQL<{
    search: { nodes: Array<PrSearchNode | null> }
  }>(
    `
      query($q: String!, $n: Int!) {
        search(query: $q, type: ISSUE, first: $n) {
          nodes {
            ... on PullRequest {
              id
              title
              url
              createdAt
              state
              mergedAt
              bodyText
              repository {
                nameWithOwner
                url
                isFork
              }
              author {
                login
                url
                avatarUrl
              }
            }
          }
        }
      }
    `,
    { q, n: options.first },
    { token: options.token },
  )

  const items: ActivityItem[] = []
  for (const node of data.search.nodes) {
    if (!node)
      continue
    if (node.repository.isFork)
      continue
    const author = node.author ?? {
      login: options.username,
      url: userHtmlUrl(options.username),
      avatarUrl: `https://github.com/${options.username}.png`,
    }

    const kind = node.mergedAt
      ? 'pull_request_merged'
      : node.state === 'CLOSED'
        ? 'pull_request_closed'
        : 'pull_request_opened'

    items.push({
      id: `pr:${node.id}`,
      kind,
      createdAt: node.createdAt,
      actor: {
        login: author.login,
        url: author.url,
        avatarUrl: author.avatarUrl,
      },
      repo: {
        name: node.repository.nameWithOwner,
        url: node.repository.url,
      },
      title: node.title,
      url: node.url,
      summary: summarizeText(node.bodyText),
    })
  }

  return items
}

async function isForkRepo(repoApiUrl: string, options: GitHubApiOptions, memo: Map<string, boolean>): Promise<boolean> {
  const cached = memo.get(repoApiUrl)
  if (typeof cached === 'boolean')
    return cached
  try {
    const repo = await fetchGitHubJson<RepoApiResponse>(repoApiUrl, options)
    const isFork = repo.fork === true
    memo.set(repoApiUrl, isFork)
    return isFork
  }
  catch {
    // If we can't determine it, do not filter it out.
    memo.set(repoApiUrl, false)
    return false
  }
}

async function fetchPullRequest(prApiUrl: string, options: GitHubApiOptions, memo: Map<string, PullRequestApiResponse | null>) {
  const cached = memo.get(prApiUrl)
  if (cached !== undefined)
    return cached
  try {
    const pr = await fetchGitHubJson<PullRequestApiResponse>(prApiUrl, options)
    memo.set(prApiUrl, pr)
    return pr
  }
  catch {
    memo.set(prApiUrl, null)
    return null
  }
}

async function normalizeEvent(event: GitHubEvent, options: GitHubApiOptions, prMemo: Map<string, PullRequestApiResponse | null>): Promise<ActivityItem | null> {
  const actor = {
    login: event.actor.login,
    url: userHtmlUrl(event.actor.login),
    avatarUrl: event.actor.avatar_url,
  }
  const repo = {
    name: event.repo.name,
    url: repoHtmlUrl(event.repo.name),
  }

  const base = {
    id: event.id,
    createdAt: event.created_at,
    actor,
    repo,
  }

  if (event.type === 'IssuesEvent') {
    const payload = event.payload as { action?: string; issue?: { html_url?: string; title?: string; body?: string } }
    if (payload.action !== 'opened')
      return null
    const title = payload.issue?.title?.trim()
    const url = payload.issue?.html_url
    if (!title || !url)
      return null
    return {
      ...base,
      kind: 'issue_opened',
      title,
      url,
      summary: summarizeText(payload.issue?.body),
    }
  }

  if (event.type === 'PullRequestEvent') {
    const payload = event.payload as {
      action?: string
      number?: number
      pull_request?: { url?: string; number?: number; merged?: boolean }
    }
    if (payload.action !== 'opened' && payload.action !== 'closed' && payload.action !== 'reopened')
      return null
    const prApiUrl = typeof payload.pull_request?.url === 'string'
      ? payload.pull_request.url
      : typeof payload.number === 'number'
        ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.number}`
        : null
    if (!prApiUrl)
      return null

    const pr = await fetchPullRequest(prApiUrl, options, prMemo)
    const title = pr?.title?.trim()
    const url = pr?.html_url
    if (!title || !url)
      return null

    const kind = payload.action === 'opened'
      ? 'pull_request_opened'
      : payload.action === 'reopened'
        ? 'pull_request_reopened'
        : pr?.merged_at
          ? 'pull_request_merged'
          : 'pull_request_closed'
    return {
      ...base,
      kind,
      title,
      url,
      summary: summarizeText(pr?.body),
    }
  }

  if (event.type === 'IssueCommentEvent') {
    const payload = event.payload as {
      action?: string
      issue?: { title?: string }
      comment?: { html_url?: string; body?: string }
    }
    if (payload.action !== 'created')
      return null
    const title = payload.issue?.title?.trim()
    const url = payload.comment?.html_url
    if (!title || !url)
      return null
    return {
      ...base,
      kind: 'issue_or_pr_comment',
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    }
  }

  if (event.type === 'PullRequestReviewEvent') {
    const payload = event.payload as {
      action?: string
      pull_request?: { url?: string; number?: number }
      review?: { html_url?: string; body?: string; state?: string }
    }
    if (payload.action !== 'created')
      return null

    const prApiUrl = typeof payload.pull_request?.url === 'string'
      ? payload.pull_request.url
      : typeof payload.pull_request?.number === 'number'
        ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.pull_request.number}`
        : null
    if (!prApiUrl)
      return null

    const pr = await fetchPullRequest(prApiUrl, options, prMemo)
    const title = pr?.title?.trim()
    const url = payload.review?.html_url ?? pr?.html_url
    if (!title || !url)
      return null

    const reviewState = reviewStateFromGitHub(payload.review?.state)
    const summary = summarizeText(payload.review?.body)

    // GitHub often emits both PullRequestReviewEvent (state: commented, body: empty)
    // and PullRequestReviewCommentEvent for the same action. The empty review entry
    // is just noise, so we drop it to avoid "duplicate" looking items.
    if (reviewState === 'commented' && !summary)
      return null

    return {
      ...base,
      kind: 'pull_request_review',
      title,
      url,
      reviewState,
      summary,
    }
  }

  if (event.type === 'PullRequestReviewCommentEvent') {
    const payload = event.payload as {
      action?: string
      pull_request?: { url?: string; number?: number }
      comment?: { html_url?: string; body?: string }
    }
    if (payload.action !== 'created')
      return null
    const prApiUrl = typeof payload.pull_request?.url === 'string'
      ? payload.pull_request.url
      : typeof payload.pull_request?.number === 'number'
        ? `https://api.github.com/repos/${event.repo.name}/pulls/${payload.pull_request.number}`
        : null
    if (!prApiUrl)
      return null

    const pr = await fetchPullRequest(prApiUrl, options, prMemo)
    const title = pr?.title?.trim()
    const url = payload.comment?.html_url
    if (!title || !url)
      return null
    return {
      ...base,
      kind: 'pull_request_review_comment',
      title,
      url,
      summary: summarizeText(payload.comment?.body),
    }
  }

  if (event.type === 'ReleaseEvent') {
    const payload = event.payload as {
      action?: string
      release?: { html_url?: string; name?: string; tag_name?: string; body?: string }
    }
    if (payload.action !== 'published')
      return null
    const titleRaw = payload.release?.name?.trim() || payload.release?.tag_name?.trim()
    const url = payload.release?.html_url
    if (!titleRaw || !url)
      return null
    return {
      ...base,
      kind: 'release_published',
      title: titleRaw,
      url,
      summary: summarizeText(payload.release?.body),
    }
  }

  return null
}

export async function getRecentActivity(options: {
  username: string
  token?: string
  limit: number
  perPage?: number
  maxPages?: number
}): Promise<ActivityResponse> {
  const limit = Math.max(1, Math.min(100, options.limit))
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100))
  const maxPages = Math.max(1, Math.min(10, options.maxPages ?? 5))

  const items: ActivityItem[] = []
  const seenUrls = new Set<string>()
  const forkMemo = new Map<string, boolean>()
  const prMemo = new Map<string, PullRequestApiResponse | null>()

  const firstUrl = new URL(`https://api.github.com/users/${options.username}/events/public`)
  firstUrl.searchParams.set('per_page', String(perPage))
  firstUrl.searchParams.set('page', '1')

  let nextUrl: string | null = firstUrl.toString()
  let pageCount = 0

  while (nextUrl && pageCount < maxPages) {
    pageCount++
    const { events, nextUrl: next } = await fetchEventsPage(nextUrl, { token: options.token })
    if (!events.length)
      break

    for (const ev of events) {
      const item = await normalizeEvent(ev, { token: options.token }, prMemo)
      if (!item)
        continue

      // Ignore fork repos
      if (await isForkRepo(ev.repo.url, { token: options.token }, forkMemo))
        continue

      if (seenUrls.has(item.url))
        continue
      seenUrls.add(item.url)

      items.push(item)
      if (items.length >= limit) {
        return {
          username: options.username,
          generatedAt: new Date().toISOString(),
          items: items.slice(0, limit),
        }
      }
    }

    nextUrl = next
  }

  // If we couldn't fill enough items (often due to Events pagination limits),
  // try adding PRs via GraphQL search when a token is available.
  if (items.length < limit && options.token) {
    try {
      const prs = await searchPullRequestsGraphQL({
        username: options.username,
        token: options.token,
        first: 50,
      })
      for (const pr of prs) {
        if (seenUrls.has(pr.url))
          continue
        seenUrls.add(pr.url)
        items.push(pr)
        if (items.length >= limit)
          break
      }
    }
    catch {
      // Ignore and return what we have.
    }
  }

  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  return {
    username: options.username,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, limit),
  }
}

export async function getRecentActivityPreview(options: {
  username: string
  token?: string
  limit: number
  perPage?: number
}): Promise<ActivityResponse> {
  const limit = Math.max(1, Math.min(100, options.limit))
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 100))

  const url = new URL(`https://api.github.com/users/${options.username}/events/public`)
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', '1')

  const { events } = await fetchEventsPage(url.toString(), { token: options.token })

  const items: ActivityItem[] = []
  const seenUrls = new Set<string>()

  for (const ev of events) {
    const item = normalizeEventPreview(ev)
    if (!item)
      continue
    if (seenUrls.has(item.url))
      continue
    seenUrls.add(item.url)
    items.push(item)
    if (items.length >= limit)
      break
  }

  return {
    username: options.username,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, limit),
  }
}
