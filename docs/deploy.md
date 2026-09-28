# Deploying JetMarket

The repo ships as a pnpm monorepo with two deployable artifacts:
`apps/web` (Next.js 15, standalone output — repo-root `Dockerfile`) and
`apps/worker` (background jobs: RFQ fan-out, match delivery, expiry sweep —
`Dockerfile.worker`, entry `pnpm --filter @jetmarket/worker start`). The
worker needs only `DATABASE_URL`; deploy it alongside web or defer it —
without it, delayed RFQs never deliver and expiries never fire.

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
- **Docker Compose (local):** `docker compose --profile app up --build`
  brings the full stack — web + worker + postgres + stripe-mock + Mailpit
  (`SEED_DEMO_DATA=1` seeds on first boot).

## Environment

All variables live in `.env.example` (the contract). Production minimums:

| Var | Prod value | Notes |
|-----|-----------|-------|
| `APP_URL` | `https://<your-domain>` | used for absolute links/emails |
| `VERTICAL` | `jets` (or `machinery`) | boots that vertical config |
| `DATABASE_URL` | `postgres://…` | required — repo + worker + expiry sweep all need it |
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
