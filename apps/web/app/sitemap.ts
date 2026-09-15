import type { MetadataRoute } from "next";
import { getVertical } from "@jetmarket/verticals";
import { seoSlugs } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const vertical = getVertical();
  const staticPaths = ["", "search", "quotes", "sign-in"];
  return [
    ...staticPaths.map((p) => ({
      url: `${base}/${p}`,
      lastModified: new Date(),
    })),
    ...seoSlugs(vertical).map((slug) => ({
      url: `${base}/${slug}`,
      lastModified: new Date(),
    })),
  ];
}
