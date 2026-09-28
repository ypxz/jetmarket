/**
 * POST /api/uploads (QA-318): the body is read with a hard byte cap before
 * formData parsing — an oversized declared content-length 413s without a
 * read, and a chunked body over the cap is cancelled mid-read. Under the cap,
 * a valid multipart image still stores.
 */
import { describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import { POST as postUpload } from "../../app/api/uploads/route";

const URL_ = "http://localhost/api/uploads";
let ipSeq = 0;
const asUser = (id: string) =>
  jar.set(sessionCookie, signSession(id, 1));

async function operator() {
  const repo = await getMemoryRepo();
  const u = await repo.createUser(
    `upl-${Math.random().toString(36).slice(2, 8)}@test.dev`,
    "operator",
  );
  asUser(u.id);
  return u;
}

const req = (init: RequestInit) =>
  new Request(URL_, {
    method: "POST",
    ...init,
    headers: {
      "fly-client-ip": `10.99.20.${(ipSeq += 1)}`,
      ...(init.headers ?? {}),
    },
  });

describe("POST /api/uploads body cap (QA-318)", () => {
  it("413s on declared content-length over the cap without reading", async () => {
    await operator();
    const res = await postUpload(
      req({
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(6 * 1024 * 1024),
        },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("413s a chunked body once the cap is crossed mid-read", async () => {
    await operator();
    const oversized = 6 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(oversized));
        c.close();
      },
    });
    const res = await postUpload(
      req({
        // stream body → chunked transfer-encoding, no content-length
        body: stream,
        // @ts-expect-error undici requires duplex for stream bodies
        duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("still stores a small valid image", async () => {
    await operator();
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", {
        type: "image/png",
      }),
    );
    const res = await postUpload(req({ body: form }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key?: string; url?: string };
    expect(body.key).toMatch(/^uploads\/.+\.png$/);
  });
});
