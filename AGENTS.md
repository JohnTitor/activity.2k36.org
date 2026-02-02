# Repository Guidelines

## Project Structure & Module Organization

- `src/` hosts the React + Vite app. `src/main.tsx` is the entrypoint, `src/App.tsx` drives data flow, `src/components/` holds UI, and `src/lib/activity/types.ts` mirrors shared types.
- `worker/src/` contains the Cloudflare Worker. Routing lives in `worker/src/index.ts`, GitHub normalization in `worker/src/github/`, cache policy in `worker/src/cache.ts`, and OG rendering in `worker/src/og.ts`.
- `dist/` is the Vite build output served by the Worker. Config is in `vite.config.ts`, `tailwind.config.ts`, `wrangler.toml`, and `tsconfig*.json`.

## Architecture Overview

- Browser → Worker → GitHub API. The Worker serves API JSON and static assets, and returns `/og.svg` for previews.
- Activity normalization filters forks, ignores push events, deduplicates by URL, and orders by `createdAt`.
- Edge cache uses `max-age=180s` and `stale-while-revalidate=300s` with a short lock to prevent stampedes.
- The frontend reads `activity-cache-v1`, fetches preview + full activity, and keeps the newest `generatedAt`.

## API Endpoints

- `GET /api/activity.preview.json`: fast, single page of events.
- `GET /api/activity.json`: full normalization with pagination + PR lookups.
- `GET /api/profile.json`: basic user profile (login, avatar).
- `GET /og.svg`: OG SVG image.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies.
- `pnpm dev`: start the Vite dev server.
- `pnpm worker:dev`: start the Worker on `http://127.0.0.1:8787` (Vite proxies `/api/*`).
- `pnpm build`, `pnpm preview`, `pnpm deploy`: build, preview, and deploy.
- `pnpm typecheck`, `pnpm lint`, `pnpm fmt`: enforce TypeScript, linting, and formatting.

## Coding Style & Naming Conventions

- TypeScript + React + Tailwind CSS. Prefer utility classes and keep shared styles in `src/styles.css`.
- Format with `oxfmt` and lint with `oxlint`.
- Use `.tsx` for components, PascalCase filenames (e.g., `ActivityList.tsx`), and camelCase symbols.

## Testing Guidelines

- No automated tests yet. Validate changes with `pnpm dev` + `pnpm worker:dev` and note manual testing in PRs.

## Commit & Pull Request Guidelines

- Commit history follows Conventional Commit-style messages (e.g., `chore(deps): ...`).
- PRs should include a short summary, testing performed, linked issues, and screenshots for UI changes.

## Configuration & Deployment Tips

- `wrangler.toml` sets `GITHUB_USERNAME` and `SITE_DOMAIN`.
- Use Wrangler secrets for tokens; do not edit `dist/` directly.
