import type { CaptchaProvider, CaptchaResult } from "./types";

/** Always-pass captcha for mock/dev mode. Token `"force-fail"` fails, for tests. */
export class MockCaptchaProvider implements CaptchaProvider {
  async verify(token: string | null | undefined): Promise<CaptchaResult> {
    if (token === "force-fail") {
      return { success: false, reason: "mock force-fail" };
    }
    return { success: true };
  }
}
