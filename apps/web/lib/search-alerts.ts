import { createHash } from "crypto";
import { site } from "@jetmarket/config";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import { listingFilterFor } from "@/lib/search";
import type { Listing, Repo, SearchAlert } from "@/lib/repo/types";

/**
 * Saved-search alerts (QA-403): a buyer saves a /search filter set; when a
 * listing activates that still matches it, they get emailed. Per-alert
 * cooldown stops activation bursts spamming one inbox — matches inside the
 * window queue onto `pendingIds` and flush as a digest once the window
 * passes (the worker's `searchAlertFlush` sweep catches them if nothing
 * new activates first).
 */
export const SEARCH_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

type AlertParams = { [key: string]: string | string[] | undefined };

/**
 * Deterministic dedupe key: same vertical + email + canonical filter → same
 * row. Canonicalization sorts keys and array values so `?a=1&b=2` and
 * `?b=2&a=1` (and multi-select order) can't fork duplicate alerts.
 */
export function searchAlertDedupeKey(
  vertical: string,
  email: string,
  params: Record<string, unknown>,
): string {
  const canon = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      const vals = (Array.isArray(v) ? v : [v]).map(String).sort();
      return `${k}=${vals.join(",")}`;
    })
    .join("&");
  return createHash("sha256")
    .update(`${vertical}|${email.toLowerCase()}|${canon}`)
    .digest("hex");
}

/** Rebuild the /search URL an alert watches (confirm redirect + mail CTA). */
export function searchAlertSearchUrl(
  origin: string,
  params: Record<string, unknown>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
  }
  const q = qs.toString();
  return `${origin}/search${q ? `?${q}` : ""}`;
}

/**
 * One-listing probe: does this listing satisfy the saved filter? Runs the
 * params back through the same whitelist → repo-filter mapping the /search
 * page uses, so "matching" can't drift from what the page shows.
 */
async function alertMatchesListing(
  repo: Repo,
  alert: SearchAlert,
  listingId: string,
): Promise<boolean> {
  const rows = await repo.listListings({
    ...listingFilterFor(alert.params as AlertParams),
    ids: [listingId],
  });
  return rows.length === 1;
}

async function sendAlertDigest(
  origin: string,
  alert: SearchAlert,
  listings: Listing[],
): Promise<void> {
  const searchUrl = searchAlertSearchUrl(origin, alert.params);
  const unsub = `${origin}/api/search-alerts/unsubscribe?token=${encodeURIComponent(
    alert.token,
  )}`;
  const first = listings[0]?.title ?? "";
  const subject =
    listings.length === 1
      ? `New listing matches your saved search — “${first}”`
      : `${listings.length} new listings match your saved search`;
  const lines = listings.map(
    (l) => `${l.title} — ${origin}/listing/${l.id}`,
  );
  await emailProvider().send({
    to: alert.email,
    subject,
    text: [
      `${lines.length === 1 ? "A new listing" : "New listings"} on ${site.name} match your saved search:`,
      "",
      ...lines,
      "",
      `Your search: ${searchUrl}`,
      `Unsubscribe: ${unsub}`,
    ].join("\n"),
    html: brandedEmailHtml({
      siteName: site.name,
      title: subject,
      paragraphs: [
        `${lines.length === 1 ? "A new listing" : "New listings"} on ${site.name} match your saved search:`,
        ...lines,
        `Unsubscribe: ${unsub}`,
      ],
      cta: { url: searchUrl, label: "See matching listings" },
    }),
  });
}

/**
 * Activation hook — called wherever a listing becomes active (create or
 * reactivate). For each ACTIVE alert in the listing's vertical that still
 * matches: outside the cooldown → mail immediately (+ any queued backlog);
 * inside → append to pendingIds for the next digest. Never fails the
 * request — every failure is logged and skipped.
 */
export async function alertSavedSearches(
  repo: Repo,
  listing: Listing,
  origin: string,
): Promise<void> {
  try {
    const alerts = await repo.listSearchAlerts({
      vertical: listing.vertical,
      status: "active",
    });
    for (const alert of alerts) {
      try {
        if (!(await alertMatchesListing(repo, alert, listing.id))) continue;
        const inCooldown =
          alert.lastAlertedAt !== null &&
          Date.now() - Date.parse(alert.lastAlertedAt) <
            SEARCH_ALERT_COOLDOWN_MS;
        if (inCooldown) {
          await repo.appendSearchAlertPending(alert.id, listing.id);
          continue;
        }
        // Not in cooldown → flush the queued backlog together with this one.
        const backlog = (
          await repo.listListings({ ids: alert.pendingIds })
        ).filter(
          (l) => l.status === "active" && l.vertical === listing.vertical,
        );
        const batch = [
          listing,
          ...backlog.filter((l) => l.id !== listing.id),
        ];
        try {
          await sendAlertDigest(origin, alert, batch);
          await repo.markSearchAlerted(alert.id);
        } catch (e) {
          logWarn("search_alerts.send_failed", {
            alertId: alert.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } catch (e) {
        logWarn("search_alerts.match_failed", {
          alertId: alert.id,
          listingId: listing.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    logWarn("search_alerts.scan_failed", {
      listingId: listing.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
