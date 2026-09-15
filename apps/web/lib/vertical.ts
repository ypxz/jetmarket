import { getVertical, getVerticalSlug, type VerticalConfig } from "@jetmarket/verticals";

// Active vertical — the ONLY place app code touches the registry. Everything
// vertical-specific (types, attributes, facets, fees, copy) comes from config.
export function verticalConfig(): VerticalConfig {
  return getVertical();
}

export function verticalSlug() {
  return getVerticalSlug();
}
