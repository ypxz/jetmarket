import type { MetadataRoute } from "next";
import { seoSlugs, siteUrl } from "@/lib/seo";

// Public routes only — app/admin/auth pages are excluded by intent.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();
  const staticPaths = [
    "",
    "search",
    "quotes",
    "sign-in",
    "tos",
    "privacy",
    "imprint",
    "design",
  ];
  return [
    ...staticPaths.map((p) => ({
      url: `${base}/${p}`,
      lastModified: now,
    })),
    ...seoSlugs().map((slug) => ({
      url: `${base}/${slug}`,
      lastModified: now,
    })),
  ];
}
