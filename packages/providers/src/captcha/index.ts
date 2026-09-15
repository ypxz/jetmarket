import { envOf } from "../env";
import type { Env } from "../env";
import { MockCaptchaProvider } from "./mock";
import { TurnstileCaptchaProvider } from "./real";
import type { CaptchaProvider } from "./types";

export * from "./types";
export { MockCaptchaProvider } from "./mock";
export { TurnstileCaptchaProvider } from "./real";

export type CaptchaProviderName = "mock" | "turnstile";

export function captchaProviderName(env?: Env): CaptchaProviderName {
  const e = envOf(env);
  return (e.CAPTCHA_PROVIDER ?? "mock").toLowerCase() === "turnstile"
    ? "turnstile"
    : "mock";
}

/** CAPTCHA_PROVIDER: mock (default, always-pass) | turnstile (fail-closed). */
export function createCaptchaProvider(env?: Env): CaptchaProvider {
  const e = envOf(env);
  switch (captchaProviderName(e)) {
    case "turnstile":
      return new TurnstileCaptchaProvider({
        secretKey: e.TURNSTILE_SECRET_KEY ?? "",
      });
    case "mock":
    default:
      return new MockCaptchaProvider();
  }
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmCaptcha?: CaptchaProvider };
export function captchaProvider(env?: Env): CaptchaProvider {
  if (!g.__jmCaptcha) g.__jmCaptcha = createCaptchaProvider(env);
  return g.__jmCaptcha;
}
