import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  transpilePackages: [
    "@jetmarket/config",
    "@jetmarket/db",
    "@jetmarket/domain",
    "@jetmarket/i18n",
    "@jetmarket/providers",
    "@jetmarket/ui",
    "@jetmarket/verticals",
  ],
};

export default withNextIntl(nextConfig);
