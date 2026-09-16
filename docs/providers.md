# Provider adapter matrix

Every external service sits behind `packages/providers/<svc>` with the same
shape: `types.ts` (interface), `mock.ts` (offline impl), `real.ts` (vendor impl),
`index.ts` (env-selected factory). App code calls the interface only — never an
SDK directly.

Flip a provider by setting `<SVC>_PROVIDER` in `.env`. Everything works with all
`mock` — zero accounts, zero network — which is what CI's default suite runs.

| Service | Env var | `mock` behavior | `real` impl | Local real-test infra |
|---|---|---|---|---|
| db | `REPO` | In-memory store + jets seed (resets on restart; `memory` default when no `DATABASE_URL`) | `postgres` — Drizzle/pg via `DATABASE_URL` | `pnpm db:up` (docker compose :5432) then `pnpm db:migrate` |
| auth | `AUTH_PROVIDER` | Any email signs in instantly (dev session cookie); `ADMIN_EMAILS` grants admin role | `supabase` — magic link | `supabase start` + `NEXT_PUBLIC_SUPABASE_*` |
| payments | `PAYMENTS_PROVIDER` | `createCheckoutSession`/`createInvoice` auto-complete + normalized webhook | `stripe` — Stripe SDK + signed webhook | stripe-mock on :12111 via compose, `STRIPE_API_BASE` |
| email | `EMAIL_PROVIDER` | Writes `EMAIL_OUTBOX_DIR` (default `tmp/outbox/*.json`) | `smtp`/`resend` skeleton (`TODO(go-live)`) | Mailpit on :1025/:8025 via compose |
| storage | `STORAGE_PROVIDER` | Files under `STORAGE_DIR`, served via `/storage/*` | `supabase` (Supabase Storage) skeleton | `supabase start` |
| captcha | `CAPTCHA_PROVIDER` | Always-pass; token `force-fail` rejects | `turnstile` (`TURNSTILE_SECRET_KEY`) | — |
| search | `SEARCH_PROVIDER` | In-process filter of repo listings | `typesense`/`meilisearch` skeleton (`TODO(go-live)`) | compose services |
| analytics | `ANALYTICS_PROVIDER` | Events to mock sink (`tmp/analytics.jsonl`) | `posthog` skeleton (`TODO(go-live)`) | — |

## Conventions the adapters enforce

- **Factories are env-selected singletons** — repo/db/rate-limit singletons
  cached on `globalThis.__jmRepo`/`__jmDb`/`__jmRateBuckets` so `next dev`
  per-request module re-imports share state. Restart dev after changing `REPO`.
- **Quota + plan checks are domain code, not provider code** — plan limits
  (free = 3 listings) and fee math (3% charter / 1.5% sale) live in
  `packages/domain` and run identically against every adapter.
- **Contract suites** pin the wire shape of stripe/mailpit against official
  mocks — run them before trusting a real key.
- **Real impls are typed skeletons + `TODO(go-live)`** — see `GO_LIVE.md` for
  the account/env-vars needed to flip each one.
