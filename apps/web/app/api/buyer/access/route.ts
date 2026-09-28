import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { emailProvider } from "@jetmarket/providers";
import { site } from "@jetmarket/config";

const Body = z.object({
  email: z.string().email().max(254),
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
    limit: MAX_LINKS_PER_MAIL,
  });
  if (rfqs.length === 0) {
    // Indistinguishable response — mailbox existence stays private.
    return ok({ sent: true });
  }

  const appUrl = process.env.APP_URL ?? new URL(req.url).origin;
  const listings = new Map(
    (
      await repo.listListings({
        ids: [...new Set(rfqs.map((r) => r.listingId).filter(Boolean))],
      })
    ).map((l) => [l.id, l.title] as const),
  );
  const lines = rfqs.map(
    (r) =>
      `- ${listings.get(r.listingId) ?? `Request ${r.id}`}: ${appUrl}/quotes?email=${encodeURIComponent(
        email,
      )}&t=${encodeURIComponent(r.accessToken)}`,
  );
  try {
    await emailProvider().send({
      to: email,
      subject: `Your ${site.name} quote links`,
      text: `Here are your request links:\n\n${lines.join("\n")}`,
    });
    logInfo("buyer.access_resent", { rfqs: rfqs.length });
  } catch (e) {
    // Provider failure is non-fatal — nothing is persisted; the buyer retries.
    logWarn("buyer.access_send_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return ok({ sent: true });
}
