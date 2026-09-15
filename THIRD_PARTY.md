# THIRD_PARTY — reused OSS and licenses

Policy (PLAN.md §4/§5): only MIT / Apache-2 / BSD / ISC code may be reused.
GPL/AGPL/SSPL/fair-code projects are read for ideas only.

| Package / project | Version | License | Used for | Notes |
|---|---|---|---|---|
| Next.js | 15 | MIT | apps/web framework | |
| React | 19 | MIT | UI | |
| TypeScript | 5 | Apache-2 | all packages | |
| pnpm | 9 | MIT | workspace | |
| Tailwind CSS | 4 | MIT | styling (via template tokens) | |
| shadcn/ui (Radix) | latest | MIT | UI primitives | |
| next-intl | 3 | MIT | i18n | |
| Drizzle ORM | latest | Apache-2 | packages/db | |
| postgres.js | latest | Unlicense† | DB driver | †Unlicense is public-domain; flag if policy tightens — MIT `pg` is the fallback |
| zod | 3 | MIT | vertical attribute/RFQ schemas | |
| Vitest | latest | MIT | unit + integration tests | |
| Playwright | latest | Apache-2 | e2e | |
| stripe (SDK) | latest | MIT | payments real adapter | tested vs stripe-mock |
| nodemailer | latest | MIT | smtp email adapter | tested vs Mailpit |
| stripe-mock | latest | MIT (Docker image) | contract tests | |
| Mailpit | latest | MIT (Docker image) | dev SMTP | |
| (template base) | — | — | apps/web + packages/ui scaffold | record starter + license once `buildApps/template` lands |

Ideas-only (NOT reused — license or weight): `sharetribe/*` (Sharetribe Community
Public Licence 1.0 — source-available, verified 2026-09-15), `medusajs` (MIT core,
except `ENTERPRISE-LICENSE.md` dirs; too heavy), `n8n` (fair-code),
`shadcn-ui/taxonomy` (MIT, unmaintained), `vercel/nextjs-subscription-payments`
(MIT, archived — billing-flow patterns only; `vercel/saas-starter` 404s, removed),
`vercel/commerce` (MIT — storefront patterns only). Detail: `RESEARCH.md` §1.
