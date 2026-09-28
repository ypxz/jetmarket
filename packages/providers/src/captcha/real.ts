import type { CaptchaProvider, CaptchaResult } from "./types";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  score?: number;
  "error-codes"?: string[];
}

export interface TurnstileOptions {
  secretKey: string; // TURNSTILE_SECRET_KEY
  /** Override for tests/self-hosted verify endpoints. */
  endpoint?: string;
}

/**
 * Cloudflare Turnstile verification. Real HTTP call — but without a secret key
 * the provider short-circuits to a safe failure, so a misconfigured deploy
 * fails closed rather than silently passing.
 * TODO(go-live): set TURNSTILE_SECRET_KEY + widget site key in web.
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export class TurnstileCaptchaProvider implements CaptchaProvider {
  constructor(private readonly opts: TurnstileOptions) {}

  async verify(
    token: string | null | undefined,
    ip?: string,
  ): Promise<CaptchaResult> {
    if (!this.opts.secretKey) {
      return { success: false, reason: "missing TURNSTILE_SECRET_KEY" };
    }
    if (!token) {
      return { success: false, reason: "missing turnstile token" };
    }
    let res: Response;
    try {
      res = await fetch(this.opts.endpoint ?? SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.opts.secretKey,
          response: token,
          remoteip: ip,
        }),
        // Cloudflare being down must fail closed, not 500 the route —
        // every RFQ POST would otherwise throw uncaught.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return {
        success: false,
        reason: `siteverify fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!res.ok) {
      return { success: false, reason: `siteverify http ${res.status}` };
    }
    let body: SiteverifyResponse;
    try {
      body = (await res.json()) as SiteverifyResponse;
    } catch {
      // A 200 with a non-JSON body (edge proxy error page) fails closed too.
      return { success: false, reason: "siteverify non-json body" };
    }
    return {
      success: body.success === true,
      score: body.score,
      reason: body["error-codes"]?.join(","),
    };
  }
}
