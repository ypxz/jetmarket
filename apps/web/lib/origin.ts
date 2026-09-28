import { logWarn } from "./log";

/**
 * Canonical public origin for absolute links placed in emails and provider
 * redirects (quote inbox links, magic links, Stripe return URLs). APP_URL is
 * the only trusted source in production: deriving the origin from the request
 * URL lets a Host-header-spoofed request inject an attacker domain into
 * token-bearing mail sent to the victim's real mailbox.
 *
 * Dev and e2e keep the request-origin fallback so local runs need no env.
 * In production a missing APP_URL fails loudly (500 on that request) rather
 * than silently minting host-derived bearer links.
 */
export function appOrigin(req: Request): string {
  const env = process.env.APP_URL?.replace(/\/+$/, "");
  if (env) return env;
  if (process.env.NODE_ENV === "production") {
    logWarn("app_origin.unset", {
      note: "APP_URL is unset in production — email/redirect links need a canonical origin",
    });
    throw new Error("APP_URL is required in production");
  }
  return new URL(req.url).origin;
}
