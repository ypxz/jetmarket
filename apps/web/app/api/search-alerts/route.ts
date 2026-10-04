import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { site } from "@jetmarket/config";
import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logWarn } from "@/lib/log";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";
import {
  searchAlertDedupeKey,
  searchAlertTargetUrl,
  searchAlertWatchId,
} from "@/lib/search-alerts";
import { verticalSlug } from "@/lib/vertical";

const Subscribe = z.object({
  email: z.string().email().max(254),
  // Raw /search params; only whitelisted keys are ever re-applied via
  // listingFilterFor, so unknown extras are inert.
  params: z.record(z.string(), z.unknown()).default({}),
  // 'daily' queues every match into the next matured-backlog digest
  // instead of instant-mailing (QA-406).
  freq: z.enum(["instant", "daily"]).default("instant"),
});

/**
 * POST {email, params} — subscribe a saved-search alert (QA-403).
 * Idempotent on (vertical, email, canonical params): re-subscribing rotates
 * the bearer token and re-arms an unsubscribed row to pending (it must
 * re-confirm). Confirm link travels by email; non-prod echoes it back like
 * the magic-link devLink so e2e can finish the flow without an inbox.
 */
export async function POST(req: Request) {
  if (
    !rateLimit(`search-alert:${clientIp(req)}`, 30, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }
  const parsed = await parseBody(req, Subscribe);
  if (parsed.error) return parsed.error;
  const email = parsed.data!.email.toLowerCase();
  if (
    !rateLimit(`search-alert:inbox:${email}`, 10, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }

  // Sanitize params to the shapes URLSearchParams produces — strings or
  // string arrays — capped so a huge body can't bloat a row.
  const params: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(parsed.data!.params ?? {}).slice(0, 40)) {
    if (typeof v === "string") params[k] = v;
    else if (
      Array.isArray(v) &&
      v.every((x) => typeof x === "string") &&
      v.length <= 12
    ) {
      params[k] = v as string[];
    }
  }

  const repo = await getRepo();
  // Listing-watch (QA-407): `watch` pins the alert to one listing id and
  // can't combine with filter params. The row must exist in THIS vertical —
  // check before the row is created so a foreign id can't be pre-watched.
  const watchId = searchAlertWatchId(params);
  if (watchId) {
    if (Object.keys(params).length > 1) {
      return err("watch cannot be combined with filters", 422);
    }
    const watched = await repo.getListing(watchId);
    if (!watched || watched.vertical !== verticalSlug()) {
      return err("listing not found", 404);
    }
  }
  const token = crypto.randomUUID();
  const { alert, created } = await repo.createSearchAlert({
    vertical: verticalSlug(),
    email,
    params,
    token,
    dedupeKey: searchAlertDedupeKey(verticalSlug(), email, params),
    freq: parsed.data!.freq,
  });

  const appUrl = appOrigin(req);
  const confirmUrl = `${appUrl}/api/search-alerts/confirm?token=${encodeURIComponent(token)}`;
  const searchUrl = searchAlertTargetUrl(appUrl, alert.params);
  // Confirm mail is the spam vector — failures must not fail the subscribe
  // (the row exists; a re-subscribe re-mints a link).
  try {
    const subject = watchId
      ? `Confirm your listing watch on ${site.name}`
      : `Confirm your saved search on ${site.name}`;
    const hook = watchId
      ? "Confirm to get an email when this listing is updated"
      : "Confirm to get an email when new listings match your search";
    await emailProvider().send({
      to: email,
      subject,
      text: `${hook}: ${confirmUrl}\n\n${watchId ? "The listing" : "Your search"}: ${searchUrl}\nUnsubscribe: ${appUrl}/api/search-alerts/unsubscribe?token=${encodeURIComponent(token)}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [
          `${hook}.`,
          `Unsubscribe: ${appUrl}/api/search-alerts/unsubscribe?token=${encodeURIComponent(token)}`,
        ],
        cta: { url: confirmUrl, label: "Confirm alert" },
      }),
    });
  } catch (e) {
    logWarn("search_alerts.confirm_mail_failed", {
      alertId: alert.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const devConfirmUrl =
    process.env.NODE_ENV === "production" ? undefined : confirmUrl;
  return ok({ ok: true, created, devConfirmUrl });
}
