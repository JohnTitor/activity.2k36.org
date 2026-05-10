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
aube install
```

### Run

Use two terminals:

- Terminal A (Worker API):

```bash
aube run worker:dev
```

- Terminal B (Frontend):

```bash
aube run dev
```

Vite proxies `/api/*` to the Worker at `http://127.0.0.1:8787`.

## Build

```bash
aube run build
```

## Deploy (Cloudflare Workers)

```bash
aube run deploy
```

- Change `vars.GITHUB_USERNAME` in `wrangler.toml` to target a different user
- Attach the custom domain `activity.2k36.org` to the Worker in Cloudflare (Custom Domain / Route)
- For Cloudflare Workers Builds, set build variable `SKIP_DEPENDENCY_INSTALL=1`
- Set the Cloudflare build command to `npm install -g --ignore-scripts=false @endevco/aube@1.9.1 && aube ci && aube run build`
- Keep the Cloudflare deploy command as `npx wrangler deploy` for production branches and `npx wrangler versions upload` for preview branches

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
