import { jetsVertical } from "./jets";
import { machineryVertical } from "./machinery";
import type { VerticalConfig, VerticalSlug } from "./types";

export * from "./types";
// Named re-exports (not `export *`) — Node's CJS named-export detection can't
// see through star-reexports, so `import { buildRfqSchema }` fails under
// plain node/tsx (apps/worker).
export { buildRfqSchema, getAttributesSchema } from "./schema";
export { jetsVertical, machineryVertical };

const registry: Record<VerticalSlug, VerticalConfig> = {
  jets: jetsVertical,
  machinery: machineryVertical,
};

export function isVerticalSlug(value: string): value is VerticalSlug {
  return value === "jets" || value === "machinery";
}

/** Resolve the active vertical slug from `VERTICAL` env (default "jets"). */
export function getVerticalSlug(env: string | undefined = process.env.VERTICAL): VerticalSlug {
  if (env === undefined || env === "") return "jets";
  if (!isVerticalSlug(env)) {
    throw new Error(
      `Unknown VERTICAL "${env}". Known verticals: ${Object.keys(registry).join(", ")}`,
    );
  }
  return env;
}

/** Load the VerticalConfig for `slug` (defaults to the `VERTICAL` env var). */
export function getVertical(slug?: string): VerticalConfig {
  return registry[getVerticalSlug(slug)];
}
