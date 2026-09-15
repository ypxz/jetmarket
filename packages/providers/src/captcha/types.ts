export interface CaptchaResult {
  success: boolean;
  /** Provider-reported score when available (0–1). */
  score?: number;
  /** Why a verification failed, for logs (never echoed to the user). */
  reason?: string;
}

/**
 * Abuse protection on the RFQ form. mock = always-pass; turnstile = real
 * Cloudflare siteverify call (needs TURNSTILE_SECRET_KEY — TODO(go-live)).
 */
export interface CaptchaProvider {
  verify(token: string | null | undefined, ip?: string): Promise<CaptchaResult>;
}
