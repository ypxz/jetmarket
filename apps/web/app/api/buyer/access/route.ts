import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { mailCopy, mailT } from "@jetmarket/i18n";
import { site } from "@jetmarket/config";
import { appOrigin } from "@/lib/origin";

const Body = z.object({
  email: z.string().email().max(254),
  // QA-493: mail locale travels in the body — API routes sit outside intl middleware.
  locale: z.enum(["en", "de"]).optional(),
});

const MAX_LINKS_PER_MAIL = 20;

// "Lost your link?" — re-emails the buyer their per-RFQ inbox links. The
// tokens only ever go to the claimed mailbox (same model as magic links),
// so the response is identical whether or not RFQs exist: no enumeration.
// Per-inbox + per-IP caps bound mail volume; each send is one email.
export async function POST(req: Request) {
  const { data, error } = await parseBody(req, Body);
  if (error) return error;
  const email = data!.email.toLowerCase();

  const ip = clientIp(req);
  if (
    !rateLimit(`buyer-access:${ip}`, 20, 60 * 60 * 1000) ||
    !rateLimit(`buyer-access:${email}`, 3, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }

  const repo = await getRepo();
  const rfqs = await repo.listRfqs({
    buyerEmail: email,
    // Per-vertical inbox: a machinery RFQ's token must not ship in a
    // jets-branded access mail (or resolve on this deploy) (QA-297).
    vertical: verticalSlug(),
    limit: MAX_LINKS_PER_MAIL,
  });
  if (rfqs.length === 0) {
    // Indistinguishable response — mailbox existence stays private.
    return ok({ sent: true });
  }

  const appUrl = appOrigin(req);
  const listings = new Map(
    (
      await repo.listListings({
        ids: [
          ...new Set(
            rfqs
              .map((r) => r.listingId)
              .filter((x): x is string => x !== null),
          ),
        ],
      })
    ).map((l) => [l.id, l.title] as const),
  );
  // QA-493: the resend mail keeps the page's locale (transient — there is
  // no persisted buyer preference, the body field is just for this send).
  const m = await mailCopy(data!.locale);
  const lines = rfqs.map((r) =>
    mailT(m, "buyerLinks.line", {
      title:
        (r.listingId ? listings.get(r.listingId) : undefined) ??
        mailT(m, "buyerLinks.request", { id: r.id }),
      url: `${appUrl}/quotes?email=${encodeURIComponent(
        email,
      )}#t=${encodeURIComponent(r.accessToken)}`,
    }),
  );
  try {
    const subject = mailT(m, "buyerLinks.subject", { site: site.name });
    const intro = mailT(m, "buyerLinks.intro");
    await emailProvider().send({
      to: email,
      subject,
      text: `${intro}\n\n${lines.join("\n")}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [intro],
        listItems: lines,
      }),
    });
    logInfo("buyer.access_resent", { rfqs: rfqs.length });
  } catch (e) {
    // Nothing was delivered — report failure so the UI prompts a retry.
    // Returning ok({sent:true}) here used to tell the buyer "check your
    // inbox" for an email that never left (QA-353).
    logWarn("buyer.access_send_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return err("couldn't send the email — try again", 502);
  }
  return ok({ sent: true });
}
