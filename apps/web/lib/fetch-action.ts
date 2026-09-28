"use client";

/**
 * Fire a mutation request and normalize failure to a displayable message —
 * null on success (the caller refreshes), the server's `error` string (the
 * useful reason, e.g. the plan-cap upsell) or `fallback` otherwise.
 * Before this helper existed, action buttons swallowed non-2xx silently (QA-211).
 */
export async function sendAction(
  url: string,
  opts: {
    method?: "POST" | "PATCH" | "DELETE";
    body?: unknown;
    fallback: string;
  },
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: opts.method ?? "POST",
      headers:
        opts.body !== undefined
          ? { "content-type": "application/json" }
          : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return data?.error ?? opts.fallback;
  } catch {
    return opts.fallback;
  }
}
