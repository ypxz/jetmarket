"use client";

/**
 * User-visible API errors: `err()` stamps a stable `code` (the slugified
 * English message) on every error response, and this module maps it through
 * the `errors.*` catalog so /de flashes German instead of the raw English
 * `error` string. The dict is registered once by <ErrorCatalog> in the root
 * layout — action helpers run inside event handlers where hooks can't reach
 * a context, hence the module store. Unmapped codes fall back to the English
 * server string (status quo ante), missing payloads to the caller's label.
 */
let dict: Record<string, string> | null = null;

export function registerErrors(errors: Record<string, string>) {
  dict = errors;
}

export function ErrorCatalog({
  errors,
}: {
  errors: Record<string, string>;
}) {
  registerErrors(errors);
  return null;
}

export function errText(
  body: { error?: string; code?: string } | null | undefined,
  fallback: string,
): string {
  const hit = body?.code ? dict?.[body.code] : undefined;
  if (hit) return hit;
  return body?.error ?? fallback;
}
