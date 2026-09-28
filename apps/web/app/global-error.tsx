"use client";

import { useEffect } from "react";

/**
 * Root error boundary — last resort for crashes outside the locale tree.
 * Renders its own <html>/<body> since the root layout may have failed;
 * copy is hardcoded English: the i18n provider may be unavailable here.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    navigator.sendBeacon(
      "/api/client-error",
      JSON.stringify({
        digest: error.digest,
        message: error.message.slice(0, 500),
        path: window.location.pathname,
      }),
    );
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border p-8 text-center">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted">
              Please try again. If the problem persists, contact support
              {error.digest ? ` (ref ${error.digest})` : ""}.
            </p>
            <button
              onClick={reset}
              className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
