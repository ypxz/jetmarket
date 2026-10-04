import { ImageResponse } from "next/og";
import { site } from "@jetmarket/config";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { isExpiredListing } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";

export const alt = `${site.name} listing`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Cache the rendered PNG per listing — without revalidate every unfurl runs
// a DB read + satori/resvg render (~100ms CPU), an unbounded public burn.
export const revalidate = 3600;

// First-party OG card rendered with ImageResponse — hex values mirror
// packages/ui/tokens.css (satori has no oklch/css-var support).
export default async function OgImage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const repo = await getRepo();
  const raw = await repo.getListing(id);
  // Same public-visibility rule as the page — an expired leg's OG card would
  // otherwise leak the title on a URL that 404s (QA-220); a foreign-vertical
  // listing's card would leak it on a shared DB too (QA-296).
  const listing =
    raw &&
    raw.vertical === verticalSlug() &&
    raw.status === "active" &&
    !isExpiredListing(raw)
      ? raw
      : null;
  const title = listing?.title ?? site.name;
  const price = listing
    ? formatMoney(listing.price, listing.currency, locale)
    : "";
  const kind = listing?.type.replace(/_/g, " ") ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 72,
          background: "#0d1420", // design-ok — brand-950 token, satori needs hex
          color: "#f5f7fa", // design-ok — scale-50 token
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: "#2b5fd9", // design-ok — brand-600 token
            }}
          />
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>
            {site.name}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {kind ? (
            <span
              style={{
                fontSize: 26,
                textTransform: "uppercase",
                letterSpacing: 3,
                color: "#8fa6d4", // design-ok — brand-300-ish on dark
              }}
            >
              {kind}
            </span>
          ) : null}
          <span style={{ fontSize: title.length > 60 ? 52 : 64, fontWeight: 700, lineHeight: 1.15 }}>
            {title}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 30,
          }}
        >
          <span style={{ color: "#8fa6d4" /* design-ok */ }}>{site.tagline}</span>
          {price ? <span style={{ fontWeight: 700 }}>{price}</span> : null}
        </div>
      </div>
    ),
    size,
  );
}
