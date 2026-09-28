import { getVertical, getVerticalSlug, type VerticalConfig } from "@jetmarket/verticals";
import en from "@jetmarket/i18n/messages/en.json";

// Active vertical — the ONLY place app code touches the registry. Everything
// vertical-specific (types, attributes, facets, fees, copy) comes from config.
export function verticalConfig(): VerticalConfig {
  return getVertical();
}

export function verticalSlug() {
  return getVerticalSlug();
}

/** The vertical's en messages subtree — for surfaces that render labels
 * without next-intl (plain-text emails). */
export function verticalMessages(): Record<string, unknown> {
  const vertical = (en.vertical ?? {}) as Record<string, unknown>;
  const ns = vertical[getVerticalSlug()];
  return (ns && typeof ns === "object" ? ns : {}) as Record<string, unknown>;
}
