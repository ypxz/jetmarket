# Deploying JetMarket

The repo ships as a pnpm monorepo. The only deployable artifact today is
`apps/web` (Next.js 15, standalone output). `apps/worker` is a stub until
T13 (RFQ fan-out) lands — its Dockerfile then runs `pnpm --filter @jetmarket/worker start`.

## Docker (web)

Build context is the **repo root** (the image needs workspace packages):

```bash
docker build -t jetmarket-web .
docker run -p 3000:3000 --env-file .env.local jetmarket-web
# health: curl localhost:3000/api/health → {"ok":true,...}
```

`apps/web/next.config.ts` sets `output: "standalone"`, so the runner stage
is ~the traced server + static assets only — no dev deps, no source.

## Platforms

- **Fly.io / Render / Railway:** point at the repo-root `Dockerfile`,
  expose port 3000, set the env vars below. Health check path `/api/health`.
- **Docker Compose (local):** `pnpm db:up` already brings postgres,
  stripe-mock and Mailpit; `docker compose up -d` plus this image covers
  the rest.

## Environment

All variables live in `.env.example` (the contract). Production minimums:

| Var | Prod value | Notes |
|-----|-----------|-------|
| `APP_URL` | `https://<your-domain>` | used for absolute links/emails |
| `VERTICAL` | `jets` (or `machinery`) | boots that vertical config |
| `DATABASE_URL` | `postgres://…` | needed once `packages/db` is wired (T4) |
| `SESSION_SECRET` | random 32+ bytes | replaces `dev-only-not-a-secret` |
| `*_PROVIDER` | `mock` → real adapter | swap per `.env.example` comments |

Everything else defaults to fully-offline mock mode — the app runs with no
external services; providers are env-selected adapters (`mock`/`real`
skeletons, `TODO(go-live)`).

## Logging & ops

- Structured logs: every API event emits one JSON line via `lib/log.ts`
  (`ts`, `level`, `event`, `service`, `vertical`, + fields) — ship
  container stdout to your log stack as-is.
- Health: `GET /api/health` → `{ok, service, vertical, time}`.
- Mock email: `EMAIL_PROVIDER=mock` writes `.eml`/`.json` to `tmp/outbox`;
  `smtp` targets Mailpit (`SMTP_URL=smtp://localhost:1025`, UI :8025).
