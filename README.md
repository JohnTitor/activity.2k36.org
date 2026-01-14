# activity.2k36.org

Web app that shows the latest GitHub activities.

Included activity:

- Issue / PR creation
- Comments on Issues / PRs (including reviews)
- Release publishing

Notes:

- Push/commit events are intentionally ignored (covered by PR activity).
- Fork repositories are ignored.

## Tech stack

- Frontend: React + Vite + TypeScript + Tailwind CSS
- Backend: Cloudflare Workers (`/api/activity.json`)

## Local development

### Install dependencies

```bash
pnpm install
```

### (Optional) GitHub token (PAT)

You can set `GITHUB_TOKEN` to avoid rate limiting and make the API more reliable.

Also, the GitHub Events API may return **422 (pagination limited)** for deep pagination. With filters like “ignore forks” and “ignore push events”, it’s possible to not reach 30 items using Events alone.

To mitigate this, when a token is available the Worker will:

- Fetch events
- Fetch PR details for PR-related events via the Pulls API (because Events payloads are trimmed)
- If still not enough items, **supplement PRs using GitHub GraphQL search**

#### Local (wrangler)

Wrangler can read `.dev.vars`:

```bash
cp .env.example .dev.vars
```

#### Cloudflare (production)

Store it as a Cloudflare secret:

```bash
wrangler secret put GITHUB_TOKEN
```

### Run

Use two terminals:

- Terminal A (Worker API):

```bash
pnpm worker:dev
```

- Terminal B (Frontend):

```bash
pnpm dev
```

Vite proxies `/api/*` to the Worker at `http://127.0.0.1:8787`.

## Build

```bash
pnpm build
```

## Deploy (Cloudflare Workers)

```bash
pnpm deploy
```

- Change `vars.GITHUB_USERNAME` in `wrangler.toml` to target a different user
- Attach the custom domain `activity.2k36.org` to the Worker in Cloudflare (Custom Domain / Route)

## API

`GET /api/activity.json`

`GET /api/activity.preview.json`

Response (high level):

- `username`: target user
- `generatedAt`: ISO timestamp
- `items`: normalized activity items

## Limitations

- Based on GitHub public activity, so **only public events** are available.
- GitHub API pagination/rate limits apply.
