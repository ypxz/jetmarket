import { ImageResponse } from "next/og";
import { site } from "@jetmarket/config";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { verticalSlug } from "@/lib/vertical";

export const alt = "JetMarket operator";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Operator OG card — same layout/tokens as the listing card so shared
// links look consistent.
export default async function OgImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepo();
  const operator = await repo.getOperator(id);
  const pub = operator ? publicOperator(operator) : null;
  const name = pub?.name ?? site.name;
  const listings = operator
    ? await repo.listListings({
        operatorId: id,
        vertical: verticalSlug(),
        status: "active",
        limit: 1,
      })
    : [];

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
          <span
            style={{
              fontSize: 26,
              textTransform: "uppercase",
              letterSpacing: 3,
              color: "#8fa6d4", // design-ok — brand-300-ish on dark
            }}
          >
            operator
          </span>
          <span
            style={{
              fontSize: name.length > 50 ? 52 : 68,
              fontWeight: 700,
              lineHeight: 1.15,
              display: "flex",
              alignItems: "center",
              gap: 20,
            }}
          >
            {name}
            {pub?.verified ? (
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: "#0d1420", // design-ok — brand-950 on accent pill
                  background: "#34d399", // design-ok — success-ish accent
                  borderRadius: 999,
                  padding: "8px 20px",
                  textTransform: "uppercase",
                  letterSpacing: 2,
                }}
              >
                verified
              </span>
            ) : null}
          </span>
          {pub?.fleetSummary ? (
            <span
              style={{
                fontSize: 30,
                color: "#c9d6f2", // design-ok — muted text on dark
                lineHeight: 1.3,
              }}
            >
              {pub.fleetSummary.slice(0, 110)}
            </span>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 30,
          }}
        >
          <span style={{ color: "#8fa6d4" /* design-ok */ }}>
            {pub?.baseAirport ?? site.tagline}
          </span>
          {listings.length ? (
            <span style={{ color: "#8fa6d4" /* design-ok */ }}>
              active on {site.name}
            </span>
          ) : null}
        </div>
      </div>
    ),
    size,
  );
}
