# Architecture Overview

This document summarizes the architecture and key flows of `activity.2k36.org`.

## System Context

```mermaid
flowchart LR
  User[Browser] -->|HTTPS| Worker[Cloudflare Worker]
  Worker -->|Fetch events/users| GitHub[GitHub API]
  Worker -->|Serve API JSON / OG SVG| User
  Worker -->|Fetch static assets| Assets[Cloudflare Assets: dist/]
```

- Frontend: React + Vite + TypeScript + Tailwind CSS.
- Backend: Cloudflare Worker that serves both API endpoints and static assets.
- External dependency: GitHub public events API.

## Repository Layout (Key Files)

- `src/main.tsx`: React entrypoint.
- `src/App.tsx`: data fetching, local cache, and page layout.
- `src/components/*`: activity list UI.
- `src/lib/activity/types.ts`: shared activity types (frontend copy).
- `worker/src/index.ts`: Worker routing and API handlers.
- `worker/src/github/events.ts`: GitHub API fetch + normalization.
- `worker/src/cache.ts`: edge cache keys and cache policy.
- `worker/src/og.ts`: OG SVG generation.
- `wrangler.toml`: Worker config and vars (`GITHUB_USERNAME`, `SITE_DOMAIN`).

## API Endpoints (Worker)

- `GET /api/activity.preview.json`
  - Fast, minimal normalization (single page of events).
- `GET /api/activity.json`
  - Full normalization (pagination + PR detail lookups).
- `GET /api/profile.json`
  - Basic GitHub user profile (login, avatar).
- `GET /og.svg`
  - Static OG image.

All endpoints are implemented in `worker/src/index.ts`.

## Data Model

Common response shape (duplicated in `src/lib/activity/types.ts` and
`worker/src/activity/types.ts`):

- `ActivityResponse`:
  - `username`: target GitHub user
  - `generatedAt`: ISO timestamp
  - `items`: array of `ActivityItem`
- `ActivityItem`:
  - `id`, `kind`, `createdAt`, `actor`, `repo`, `title`, `url`
  - optional `summary`, `reviewState`

## Frontend Behavior (App)

`src/App.tsx` implements the UI data flow:

- Reads localStorage cache (`activity-cache-v1`) on mount.
- Requests `GET /api/profile.json` for avatar/login.
- Requests both:
  - `GET /api/activity.preview.json` (fast)
  - `GET /api/activity.json` (authoritative)
- Uses `generatedAt` to avoid overwriting newer data with older data.
- When full fetch fails:
  - Uses cached data (if available).
  - Otherwise shows an error panel.

## Edge Caching Strategy (Worker)

Implemented in `worker/src/cache.ts` and used by `worker/src/index.ts`.

- Cache policy: `max-age=180s`, `stale-while-revalidate=300s`.
- Uses Cache API (`caches.default`) with normalized cache keys.
- Adds `x-generated-at` header to responses.
- On stale responses:
  - Serves stale content immediately.
  - Triggers background refresh via `ctx.waitUntil(...)`.
  - Uses a short-lived lock key to avoid stampedes (~15s per PoP).

## Sequence Diagrams

### 1) Page Load + Activity Refresh

```mermaid
sequenceDiagram
  participant B as Browser (App)
  participant LS as localStorage
  participant W as Worker
  B->>LS: Read activity-cache-v1
  LS-->>B: Cached ActivityResponse? (optional)
  B->>W: GET /api/activity.preview.json
  B->>W: GET /api/activity.json
  W-->>B: Preview response (fast)
  W-->>B: Full response (authoritative)
  B->>LS: Write newest response
  B-->>B: Render list
```

### 2) Worker Cache for /api/activity.json

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as Worker
  participant C as Cache API
  participant G as GitHub API

  B->>W: GET /api/activity.json
  W->>C: match(cacheKey)
  alt Cache HIT (fresh)
    C-->>W: cached response
    W-->>B: 200 (x-cache=HIT)
  else Cache HIT (stale)
    C-->>W: cached response
    W-->>B: 200 (x-cache=STALE)
    W->>C: check lock key
    alt Lock expired or missing
      W->>G: Fetch events + PR details
      G-->>W: ActivityResponse
      W->>C: put(cacheKey, fresh response)
    end
  else Cache MISS
    W->>G: Fetch events + PR details
    G-->>W: ActivityResponse
    W->>C: put(cacheKey, fresh response)
    W-->>B: 200 (x-cache=MISS)
  end
```

### 3) GitHub Normalization (Full)

```mermaid
sequenceDiagram
  participant W as Worker
  participant G as GitHub API

  W->>G: GET /users/:username/events/public?page=1..N
  G-->>W: Event pages
  loop For each event
    W->>G: (Optional) Fetch PR details for title/merged
    W->>G: (Optional) Fetch repo to detect forks
  end
  W-->>W: Normalize, dedupe by URL, sort by createdAt
```

### 4) Profile Fetch

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as Worker
  participant G as GitHub API

  B->>W: GET /api/profile.json
  W->>G: GET /users/:username
  G-->>W: login + avatar_url
  W-->>B: JSON profile
```

### 5) OG Image

```mermaid
sequenceDiagram
  participant Client
  participant W as Worker
  participant C as Cache API

  Client->>W: GET /og.svg
  W->>C: match(ogCacheKey)
  alt Cache HIT
    C-->>W: SVG
    W-->>Client: SVG (x-cache=HIT)
  else Cache MISS
    W-->>W: renderOgSvg()
    W->>C: put(ogCacheKey)
    W-->>Client: SVG (x-cache=MISS)
  end
```

## Important Behaviors / Constraints

- Only public GitHub events are available.
- Push/commit events are intentionally ignored.
- Fork repositories are filtered out (requires per-repo API check).
- Activity items are deduplicated by URL.
- Deep pagination can return GitHub 422; the worker treats this as "no more pages".

## Local Development

- Start Worker API: `pnpm worker:dev` (port 8787).
- Start frontend: `pnpm dev` (Vite proxy to Worker at `/api/*`).

## Deployment Notes

- `pnpm build` outputs `dist/` and is served by the Worker via `ASSETS`.
- `wrangler.toml` controls target user and domain:
  - `GITHUB_USERNAME` (default: `JohnTitor`)
  - `SITE_DOMAIN` (default: `activity.2k36.org`)
