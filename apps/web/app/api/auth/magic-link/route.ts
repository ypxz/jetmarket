import { z } from "zod";
import { site } from "@jetmarket/config";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { localePath, mailCopy, mailT } from "@jetmarket/i18n";
import { logWarn } from "@/lib/log";
import { signMagicLink } from "@/lib/auth";
import { appOrigin } from "@/lib/origin";

const Body = z.object({
  email: z.string().email().max(254),
  role: z.enum(["buyer", "operator"]).default("buyer"),
  // QA-493: sign-in mail keeps the page locale (transient, no user pref).
  locale: z.enum(["en", "de"]).optional(),
});

export async function POST(req: Request) {
  const { data, error } = await parseBody(req, Body);
  if (error) return error;
  const { email, role, locale } = data!;

  // Only mock auth exists — check before doing any work so a real-provider
  // deploy doesn't rate-burn or mail a link for a request we then 501.
  if ((process.env.AUTH_PROVIDER ?? "mock") !== "mock") {
    return err("real auth provider not configured (TODO go-live)", 501);
  }

  // Per-IP + per-inbox: the link email is the spam vector.
  if (
    !rateLimit(`ml:${clientIp(req)}`, 30, 60 * 60 * 1000) ||
    !rateLimit(`ml:${email.toLowerCase()}`, 10, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }

  const repo = await getRepo();
  const adminEmails = (process.env.ADMIN_EMAILS ?? "admin@jetmarket.local")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  // QA-536: allowlist entries may carry a `*` wildcard segment
  // (`e2e-admin-*@jetmarket.local` → prefix/suffix match) so test fleets
  // mint per-spec admin inboxes without sharing one ml:<email> bucket.
  // Exact entries match byte-for-byte — prod config unchanged.
  const lower = email.toLowerCase();
  const isAdminEmail = adminEmails.some((e) => {
    if (!e.includes("*")) return e === lower;
    const star = e.indexOf("*");
    return lower.startsWith(e.slice(0, star)) && lower.endsWith(e.slice(star + 1));
  });
  const resolvedRole = isAdminEmail ? "admin" : role;
  // QA-494: the sign-in page's locale stamps users.locale (adopt-latest) —
  // operator/admin-facing mail renders in it from here on.
  const user = await repo.createUser(email, resolvedRole, locale);
  // ADMIN_EMAILS is the admin source of truth: sync on each sign-in request —
  // a listed returning user is promoted, a removed one loses admin access.
  if (user.role === "admin" || resolvedRole === "admin") {
    if (user.role !== resolvedRole && resolvedRole) {
      await repo.setUserRole(user.id, resolvedRole);
    }
  }

  const appUrl = appOrigin(req);
  // Operator intent lands on onboarding (no profile yet) or the dashboard;
  // buyer intent on the home page. An existing buyer choosing "I operate"
  // still lands on onboarding — the role upgrade happens at the first
  // profile POST (QA-267).
  const next =
    resolvedRole === "operator"
      ? (await repo.getOperatorByUserId(user.id))
        ? "/app"
        : "/app/onboarding"
      : "/";
  // QA-496: the post-callback landing keeps the page locale the sign-in
  // form was submitted from — a /de sign-in returns onto /de/app.
  const link = `${appUrl}/api/auth/callback?token=${encodeURIComponent(signMagicLink(user.id))}&next=${encodeURIComponent(localePath(locale, next))}`;
  // QA-493: sign-in mail in the page's locale.
  const m = await mailCopy(locale);
  const subject = mailT(m, "magicLink.subject", { site: site.name });
  try {
    await emailProvider().send({
      to: email,
      subject,
      text: mailT(m, "magicLink.text", { url: link }),
      html: brandedEmailHtml({
        siteName: site.name,
        title: mailT(m, "magicLink.title"),
        paragraphs: [mailT(m, "magicLink.intro")],
        cta: { url: link, label: mailT(m, "magicLink.cta") },
      }),
    });
  } catch (e) {
    // The email IS the deliverable — a provider blip must surface a clean
    // retry prompt, not an unhandled 500 (QA-353).
    logWarn("auth.magic_link_send_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return err("couldn't send the sign-in email — try again", 502);
  }

  // Dev/test only: also return the link so the flow is demoable without
  // outbox access. In production this must NEVER ship — the response is
  // attacker-controlled input (any mailbox), and a live link in JSON is an
  // account-takeover primitive when AUTH_PROVIDER stays at its mock default
  // (QA-177).
  const devLink =
    process.env.NODE_ENV === "production" ? undefined : link;
  // No `role` in the response: resolvedRole flips to "admin" for
  // ADMIN_EMAILS members, and echoing it would let an unauthenticated probe
  // enumerate the admin roster (QA-301). Uniform {sent:true} for all.
  return ok({ sent: true, devLink });
}
