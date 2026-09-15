# GO_LIVE — how the human takes this template/product live

Fill this in per product (rename to GO_LIVE.md). Every step the agent could not
do without accounts/keys lives here.

## 1. Accounts to create (human-only — need card/phone/identity)
- [ ] **Stripe** — stripe.com register → create product "Pro" monthly → copy
      `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO`, set `STRIPE_WEBHOOK_SECRET`
      after adding the webhook endpoint (`POST /api/billing/webhook`).
- [ ] **Supabase** (optional — only if AUTH/STORAGE_PROVIDER=supabase) —
      supabase.com new project → `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Or use
      managed Postgres only (`DATABASE_URL`) with any host.
- [ ] **OpenAI** — platform.openai.com API keys → `OPENAI_KEY` (if
      LLM_PROVIDER=openai).
- [ ] **Resend / SMTP** — resend.com key (`RESEND_API_KEY`) or any SMTP URL.
- [ ] **PostHog** (optional) — `NEXT_PUBLIC_POSTHOG_KEY` + host.

## 2. Env changes from mock → real
```
DB_PROVIDER=postgres        DATABASE_URL=<real>
AUTH_PROVIDER=supabase      (+ supabase vars)
PAYMENTS_PROVIDER=stripe    (+ stripe vars)
LLM_PROVIDER=openai         OPENAI_KEY=...
EMAIL_PROVIDER=smtp|resend  SMTP_URL=... | RESEND_API_KEY=...
STORAGE_PROVIDER=supabase   (+ supabase vars)
ANALYTICS_PROVIDER=posthog  NEXT_PUBLIC_POSTHOG_KEY=...
```

## 3. Deploy (one-command notes)
- **Vercel**: import repo → root = `apps/web` is auto-detected in monorepo;
  set env vars from step 2 → deploy. `pnpm build` must pass.
- **Fly/Railway**: `docker build -f apps/web/Dockerfile .` then deploy image;
  same env vars.

## 4. Post-deploy checks
- `pnpm smoke -- --url=https://<domain>` green
- `curl https://<domain>/api/health` shows real provider names
- Stripe webhook delivers `checkout.session.completed` → subscription row

## 5. Expected monthly cost
| service | free tier | light prod |
|---|---|---|
| Vercel | hobby $0 | $20 |
| Postgres (Neon/Supabase) | $0 | $0–25 |
| Stripe | $0 + % | per-txn |
| OpenAI | — | $5–50 |
| Resend | 3k/mo $0 | $20 |
