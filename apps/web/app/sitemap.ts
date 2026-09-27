import type { MetadataRoute } from "next";
import { seoSlugs, siteUrl } from "@/lib/seo";

// Public routes only — app/admin/auth pages are excluded by intent.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();
  // Only indexable public pages: the home page, legal/imprint, and the
  // dedicated SEO landing slugs. search/quotes/sign-in are no-index surfaces.
  const staticPaths = ["", "tos", "privacy", "imprint"];
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
