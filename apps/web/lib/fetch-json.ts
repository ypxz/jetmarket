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
