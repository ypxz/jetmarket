import { describe, expect, it } from "vitest";
import { errText, registerErrors } from "@/lib/error-catalog";

// QA-495: API error envelopes carry a slugged `code`; errText maps it through
// the registered errors.* dict, falling back to the English `error` string
// then the caller's label.
describe("errText", () => {
  registerErrors({
    invalid_fields: "Einige Felder sind ungültig — bitte prüfen Sie das Formular.",
    listing_not_found: "Inserat nicht gefunden.",
  });

  it("maps a known code through the registered catalog", () => {
    expect(
      errText({ error: "invalid fields", code: "invalid_fields" }, "oops"),
    ).toBe("Einige Felder sind ungültig — bitte prüfen Sie das Formular.");
  });

  it("falls back to the server string for unmapped codes", () => {
    expect(
      errText({ error: "something bespoke", code: "something_bespoke" }, "oops"),
    ).toBe("something bespoke");
  });

  it("uses the caller fallback when the body has neither", () => {
    expect(errText({}, "oops")).toBe("oops");
    expect(errText(null, "oops")).toBe("oops");
    expect(errText(undefined, "oops")).toBe("oops");
  });
});
