"use client";

import { buttonVariants } from "@jetmarket/ui";
import { useEffect, useState } from "react";

function bearerToken(): string | null {
  return (
    new URLSearchParams(window.location.hash.slice(1)).get("t") ??
    new URLSearchParams(window.location.search).get("t")
  );
}

/**
 * "Track your quotes" link — resolves the bearer token from this page's URL
 * fragment (`#t=`) into the /quotes fragment form, so the token never crosses
 * a server-side URL (access logs / Referer). Legacy `?t=` links still work:
 * the same token is re-emitted as a fragment. With no token at all the link
 * still lands on /quotes, which offers the resend flow.
 */
export function ThanksQuotesLink({ email, label }: { email: string; label: string }) {
  const base = `/quotes?email=${encodeURIComponent(email)}`;
  const [href, setHref] = useState(base);
  useEffect(() => {
    const token = bearerToken();
    if (token) {
      setHref(`${base}#t=${encodeURIComponent(token)}`);
    }
    // Scrub any legacy ?t= off the address bar immediately.
    if (new URLSearchParams(window.location.search).has("t")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("t");
      window.history.replaceState(null, "", url.toString());
    }
  }, [email]);
  return (
    <a
      href={href}
      className={`${buttonVariants()} mt-6`}
      data-testid="rfq-view-quotes"
      // Hydration race: the effect-set href may not have landed before a fast
      // click — re-resolve the fragment token synchronously at click time.
      onClick={(e) => {
        const token = bearerToken();
        if (token) {
          e.currentTarget.href = `${base}#t=${encodeURIComponent(token)}`;
        }
      }}
    >
      {label}
    </a>
  );
}
