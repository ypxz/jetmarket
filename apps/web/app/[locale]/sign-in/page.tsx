"use client";

import { useState } from "react";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"buyer" | "operator">("buyer");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const data = (await res.json()) as { devLink?: string };
    setDevLink(data.devLink ?? null);
    setSent(true);
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted">
        We email you a magic link. No password needed.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          data-testid="signin-email"
          className="w-full rounded-md border border-border bg-background px-3 py-2"
        />
        <div className="flex gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={role === "buyer"}
              onChange={() => setRole("buyer")}
            />
            I&apos;m a buyer
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={role === "operator"}
              onChange={() => setRole("operator")}
            />
            I&apos;m an operator
          </label>
        </div>
        <button
          type="submit"
          data-testid="signin-submit"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          Send magic link
        </button>
      </form>
      {sent ? (
        <div className="mt-6 rounded-md border border-border bg-surface p-4 text-sm">
          <p>Link sent. In mock mode it is also right here:</p>
          {devLink ? (
            <a
              href={devLink}
              data-testid="signin-devlink"
              className="mt-2 block break-all font-medium text-primary underline"
            >
              Continue to JetMarket →
            </a>
          ) : null}
        </div>
      ) : null}
      <p className="mt-8 text-xs text-muted">
        Tip: sign in as <code>admin@jetmarket.local</code> for the admin area.
      </p>
    </main>
  );
}
