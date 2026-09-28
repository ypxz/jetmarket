import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/api";
import {
  consumeMagicLink,
  sessionCookie,
  signSession,
  verifyMagicLink,
} from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { site } from "@jetmarket/config";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const safeNext = (raw: string | null): string =>
  // `next` must be a site-relative path — an absolute URL would ride the
  // session cookie to an attacker domain (open redirect).
  raw?.startsWith("/") && !raw.startsWith("//") ? raw : "/";

function confirmPage(token: string, next: string): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Confirm sign-in — ${esc(
    site.name,
  )}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="text-align:center;max-width:22rem">
<h1 style="font-size:1.25rem;font-weight:600;margin-bottom:.5rem">Finish signing in</h1>
<p style="margin-bottom:1.5rem">Click below to continue to ${esc(site.name)}.</p>
<form method="POST" action="/api/auth/callback">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(next)}">
<button data-testid="confirm-signin" type="submit" style="padding:.75rem 1.5rem;font-size:1rem;cursor:pointer">Sign in to ${esc(
    site.name,
  )}</button>
</form>
</main></body></html>`;
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Never let a scanner's cache of the confirm page be replayed later.
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!rateLimit(`auth-callback:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return NextResponse.redirect(
      new URL("/sign-in?error=rate-limited", url.origin),
    );
  }
  const token = url.searchParams.get("token") ?? undefined;
  // Verify only — do NOT consume on GET. Mail scanners and link prefetchers
  // hit the link before the user does; consuming here would burn the
  // single-use token and lock the real user out. The user completes sign-in
  // by posting the confirm form (scanners don't POST).
  const userId = verifyMagicLink(token);
  if (!userId || !token) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid-token", url.origin),
    );
  }
  const next = safeNext(url.searchParams.get("next"));
  return confirmPage(token, next);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  // Login-CSRF guard: a cross-site form POST would sign the victim in as the
  // attacker (they'd consume the attacker's token and ride the attacker's
  // session). Browsers always send Origin on POST form submits; only a
  // matching Origin is accepted (absent = non-browser client, allowed).
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid-token", url.origin),
    );
  }
  if (!rateLimit(`auth-callback:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return NextResponse.redirect(
      new URL("/sign-in?error=rate-limited", url.origin),
    );
  }
  let token: string | undefined;
  let next = "/";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    const body = (await req.json().catch(() => null)) as {
      token?: string;
      next?: string;
    } | null;
    token = body?.token;
    next = safeNext(body?.next ?? null);
  } else {
    const form = await req.formData().catch(() => null);
    token = form?.get("token")?.toString();
    next = safeNext(form?.get("next")?.toString() ?? null);
  }
  const userId = consumeMagicLink(token);
  if (!userId || !token) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid-token", url.origin),
    );
  }
  const user = await (await getRepo()).getUser(userId);
  if (!user) {
    return NextResponse.redirect(
      new URL("/sign-in?error=invalid-token", url.origin),
    );
  }
  const res = NextResponse.redirect(new URL(next, url.origin));
  res.cookies.set(sessionCookie, signSession(user.id, user.sessionVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
