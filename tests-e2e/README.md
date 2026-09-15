# tests-e2e — JetMarket test harness (T8)

```
tests-e2e/
  e2e/               Playwright specs that run in `pnpm test:e2e` + CI
  pending/           specs written ahead of the app (see TESTIDS.md — promote by git mv)
  contract/          vitest contract harness vs docker services (stripe-mock, Mailpit)
  helpers/           actor-level e2e helpers (magic-link login, listing creation, outbox)
  scripts/smoke.mjs  deploy smoke: /api/health + home render, no browser needed
  TESTIDS.md         the data-testid contract app workers must satisfy
```

## Commands (from repo root)

| Command | What |
|---|---|
| `pnpm test:e2e` | Playwright `e2e/` specs; boots `pnpm dev` itself on an isolated DB |
| `pnpm test:contract` | vitest contract specs (skip cleanly when docker services are down) |
| `pnpm test:pending` | run `pending/` specs (e.g. while W3's public pages land) |
| `VERTICAL=machinery pnpm test:pending` | machinery-vertical loop |
| `pnpm smoke --url=https://…` | smoke any deploy |
| `pnpm test:all` | services → lint → typecheck → unit → integration → contract → e2e |

## Notes

- `webServer` boots `pnpm dev` with `DATABASE_URL=$TEST_DATABASE_URL`
  (`jetmarket_test`, auto-created by `global-setup.ts` once `packages/db` ships
  migrate/seed). While the slice runs on the in-memory repo, DB provisioning is
  skipped — `E2E_REQUIRE_DB=1` forces it.
- `E2E_BASE_URL` points the whole suite at an existing deploy (no local boot).
- Contract helpers are reusable by other packages:
  `import { smtpSend } from '@jetmarket/tests-e2e/contract/smtp'`
  (`import { SERVICES, probe } from '@jetmarket/tests-e2e/contract/services'`).
  Add a service to `SERVICES` + `vitest.global-setup.ts` to get an `inject()` flag.
