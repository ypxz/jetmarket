import { createHash } from "crypto";
import { site } from "@jetmarket/config";
import { mailCopy, mailT } from "@jetmarket/i18n";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { formatMoney } from "@/lib/format";
import { logWarn } from "@/lib/log";
import { listingFilterFor } from "@/lib/search";
import { verticalConfig, verticalMessages } from "@/lib/vertical";
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

/**
 * Listing-watch (QA-407): `params.watch` pins the alert to ONE listing id —
 * it fires on every saved-search alert event for that row (activation AND
 * live edits: price cuts, attr changes), never on other listings.
 */
export function searchAlertWatchId(
  params: Record<string, unknown>,
): string | null {
  const w = params["watch"];
  return typeof w === "string" && w.length > 0 ? w : null;
}

/** Where an alert's links point: watched listing page, else the saved /search. */
export function searchAlertTargetUrl(
  origin: string,
  params: Record<string, unknown>,
): string {
  const w = searchAlertWatchId(params);
  return w ? `${origin}/listing/${w}` : searchAlertSearchUrl(origin, params);
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

/** Resolve a dotted labelKey inside the vertical's en messages subtree. */
function vLabel(key: string): string | null {
  let cur: unknown = verticalMessages();
  for (const part of key.split(".")) {
    cur =
      cur && typeof cur === "object"
        ? (cur as Record<string, unknown>)[part]
        : undefined;
  }
  return typeof cur === "string" ? cur : null;
}

/**
 * Human recap of a saved filter set (QA-409) — the /quotes management list
 * shows this instead of raw `k=v` pairs. Mirrors listingFilterFor's param
 * grammar: enum/text facets read as `key`, number ranges as `keyMin/Max`,
 * date ranges as `keyFrom/To`. Watch rows and leftover unknown keys are
 * skipped (watch rows render via their own label; unknown keys were never
 * matchable anyway).
 */
export function searchAlertSummary(
  params: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const str = (v: unknown) =>
    typeof v === "string" && v !== "" ? v : undefined;
  const seen = new Set<string>();
  for (const facet of verticalConfig().facets) {
    const label = vLabel(facet.labelKey) ?? facet.key;
    if (facet.type === "number-range") {
      const min = str(params[`${facet.key}Min`]);
      const max = str(params[`${facet.key}Max`]);
      if (min !== undefined || max !== undefined) {
        seen.add(`${facet.key}Min`);
        seen.add(`${facet.key}Max`);
        out.push(`${label}: ${min ?? "0"}–${max ?? "∞"}`);
      }
      continue;
    }
    if (facet.type === "date-range") {
      const from = str(params[`${facet.key}From`]);
      const to = str(params[`${facet.key}To`]);
      if (from !== undefined || to !== undefined) {
        seen.add(`${facet.key}From`);
        seen.add(`${facet.key}To`);
        out.push(`${label}: ${from ?? "…"} → ${to ?? "…"}`);
      }
      continue;
    }
    const raw = str(params[facet.key]);
    if (raw === undefined) continue;
    seen.add(facet.key);
    // enum facets map option values to labels; text facets show the code.
    const opt = facet.options?.find((o) => o.value === raw);
    const value = opt ? (vLabel(opt.labelKey) ?? raw) : raw;
    out.push(`${label}: ${value}`);
  }
  // Leftover keys (`q` free-text, unknown params) show raw; `watch` is
  // skipped — the caller renders watch rows with their own label.
  for (const [k, v] of Object.entries(params)) {
    if (seen.has(k) || k === "watch") continue;
    const val = Array.isArray(v) ? v.join("/") : str(v);
    if (val) out.push(`${k}: ${val}`);
  }
  return out;
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
  // Watchlist rows match by id only — the QA-404 liveEdit hook is what
  // makes a price cut an alert event for watchers.
  const watch = searchAlertWatchId(alert.params);
  if (watch) return watch === listingId;
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
  priceDropFrom?: number,
): Promise<void> {
  const watch = searchAlertWatchId(alert.params);
  const targetUrl = searchAlertTargetUrl(origin, alert.params);
  const unsub = `${origin}/api/search-alerts/unsubscribe?token=${encodeURIComponent(
    alert.token,
  )}`;
  const first = listings[0]?.title ?? "";
  // A watch row only ever matches its one listing — the mail is an update,
  // not a "new match". QA-459: when the trigger was a price DECREASE the
  // mail says so — old→new is the actionable signal (Kayak-style).
  // QA-493: digests read the alert's stamped locale.
  const m = await mailCopy(alert.locale);
  const drop = watch !== null && priceDropFrom !== undefined;
  const subject = drop
    ? mailT(m, "alertDigest.subjectDrop", { title: first })
    : watch
      ? mailT(m, "alertDigest.subjectWatch", { title: first })
      : listings.length === 1
        ? mailT(m, "alertDigest.subjectOne", { title: first })
        : mailT(m, "alertDigest.subjectMany", { count: listings.length });
  const intro = drop
    ? mailT(m, "alertDigest.introDrop", { site: site.name })
    : watch
      ? mailT(m, "alertDigest.introWatch", { site: site.name })
      : mailT(
          m,
          listings.length === 1 ? "alertDigest.introOne" : "alertDigest.introMany",
          { site: site.name },
        );
  const loc = alert.locale === "de" ? "de" : "en";
  const lines = listings.map((l) =>
    drop
      ? mailT(m, "alertDigest.lineDrop", {
          title: l.title,
          old: formatMoney(priceDropFrom!, l.currency, loc),
          new: formatMoney(l.price, l.currency, loc),
          url: `${origin}/listing/${l.id}`,
        })
      : mailT(m, "alertDigest.line", {
          title: l.title,
          url: `${origin}/listing/${l.id}`,
        }),
  );
  await emailProvider().send({
    to: alert.email,
    subject,
    text: [
      intro,
      "",
      ...lines,
      "",
      `${watch ? mailT(m, "alertConfirm.theListing") : mailT(m, "alertConfirm.yourSearch")}: ${targetUrl}`,
      `${mailT(m, "shared.unsubscribe")}: ${unsub}`,
    ].join("\n"),
    html: brandedEmailHtml({
      siteName: site.name,
      title: subject,
      paragraphs: [intro, ...lines, `${mailT(m, "shared.unsubscribe")}: ${unsub}`],
      cta: {
        url: targetUrl,
        label: watch ? mailT(m, "alertDigest.ctaWatch") : mailT(m, "alertDigest.cta"),
      },
    }),
  });
}

/**
 * End-of-watch (QA-408): archiving is operator-terminal — the watched row
 * can never come back, so every watch on it is dead. Mail each watcher a
 * "watch ended" notice and flip their alert 'off' (a fresh subscribe would
 * be needed anyway since the listing is gone). Pauses do NOT end watches:
 * reactivation already re-mails via the activation hook. Never fails the
 * request — per-alert failures log and skip.
 */
export async function endListingWatches(
  repo: Repo,
  listing: Listing,
  origin: string,
): Promise<void> {
  try {
    const watchers = await repo.listSearchAlerts({
      vertical: listing.vertical,
      status: "active",
      watchListingId: listing.id,
    });
    for (const alert of watchers) {
      try {
        const searchUrl = searchAlertSearchUrl(origin, {});
        // QA-493: the watcher reads the alert's stamped locale.
        const m = await mailCopy(alert.locale);
        const subject = mailT(m, "watchEnded.subject", {
          title: listing.title,
        });
        const intro = mailT(m, "watchEnded.intro", { site: site.name });
        await emailProvider().send({
          to: alert.email,
          subject,
          text: [
            intro,
            "",
            listing.title,
            "",
            mailT(m, "watchEnded.browse", { url: searchUrl }),
          ].join("\n"),
          html: brandedEmailHtml({
            siteName: site.name,
            title: subject,
            paragraphs: [intro, listing.title],
            cta: { url: searchUrl, label: mailT(m, "watchEnded.cta") },
          }),
        });
        await repo.unsubscribeSearchAlert(alert.token);
      } catch (e) {
        logWarn("search_alerts.watch_end_failed", {
          alertId: alert.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    logWarn("search_alerts.watch_end_scan_failed", {
      listingId: listing.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
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
  /** QA-459: set to the pre-write price when this activation was a live
   *  price DECREASE — watchers get "Price dropped {old} → {new}" instead
   *  of the generic update. Raises and non-price edits stay generic. */
  opts?: { priceDropFrom?: number },
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
        // 'daily' cadence (QA-406) queues EVERY match into pending_ids —
        // the worker's matured-backlog flush is its only delivery path.
        if (alert.freq === "daily" || inCooldown) {
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
          await sendAlertDigest(origin, alert, batch, opts?.priceDropFrom);
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
