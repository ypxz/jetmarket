import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api",
        "/app",
        "/admin",
        "/search",
        "/quotes",
        "/en/app",
        "/en/admin",
        "/en/search",
        "/en/quotes",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
