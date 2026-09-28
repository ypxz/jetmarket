/**
 * Client-side fetch+parse hardened against non-JSON responses.
 * In dev a route being recompiled can answer 404/empty/HTML for a beat —
 * `res.json()` then throws `Unexpected end of JSON input`, which surfaced
 * as a client error + Fast Refresh reload (QA-17). Reads text first and
 * throws a descriptive error instead of a bare SyntaxError.
 */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `non-JSON response (${res.status}) from ${res.url}: ${text.slice(0, 80)}`,
      );
    }
  }
  return data as T;
}

export async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<{ data: T; res: Response }> {
  const res = await fetch(input, init);
  return { data: await readJson<T>(res), res };
}

/**
 * Best-effort body read for error paths: a proxy/gateway failure answers
 * HTML, not JSON, and a caller that only wants `error?` must not inherit
 * readJson's throw (QA-174 — the descriptive throw stays for success paths
 * where a malformed body really is exceptional).
 */
export async function readJsonOr<T>(res: Response, fallback: T): Promise<T> {
  try {
    return await readJson<T>(res);
  } catch {
    return fallback;
  }
}
