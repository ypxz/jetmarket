import { ImageResponse } from "next/og";
import { site } from "@jetmarket/config";

export const alt = "JetMarket";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Site-wide OG card — mirrors tokens.css in hex (satori has no oklch/css-var
// support). Listing pages override this with their own opengraph-image.
export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 24,
          width: "100%",
          height: "100%",
          padding: 96,
          background: "#0d1420", // design-ok — brand-950 token, satori needs hex
          color: "#f5f7fa", // design-ok — scale-50 token
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: "#2b5fd9", // design-ok — brand-600 token
            }}
          />
          <span style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2 }}>
            {site.name}
          </span>
        </div>
        <span style={{ fontSize: 34, color: "#8fa6d4" /* design-ok */ }}>
          {site.tagline}
        </span>
      </div>
    ),
    size,
  );
}
