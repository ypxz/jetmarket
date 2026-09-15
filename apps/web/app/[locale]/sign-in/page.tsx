"use client";

import { readJson } from "@/lib/fetch-json";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function SignInPage() {
  const t = useTranslations("auth");
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
    const data = await readJson<{ devLink?: string }>(res);
    setDevLink(data.devLink ?? null);
    setSent(true);
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("loginTitle")}</h1>
      <p className="mt-2 text-sm text-muted">{t("noPassword")}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
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
            {t("buyer")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={role === "operator"}
              onChange={() => setRole("operator")}
            />
            {t("operator")}
          </label>
        </div>
        <button
          type="submit"
          data-testid="signin-submit"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          {t("submit")}
        </button>
      </form>
      {sent ? (
        <div className="mt-6 rounded-md border border-border bg-surface p-4 text-sm">
          <p>{t("sentLine")}</p>
          {devLink ? (
            <a
              href={devLink}
              data-testid="signin-devlink"
              className="mt-2 block break-all font-medium text-primary underline"
            >
              {t("continue")}
            </a>
          ) : null}
        </div>
      ) : null}
      <p className="mt-8 text-xs text-muted">
        {t("adminTip", { email: "admin@jetmarket.local" })}
      </p>
    </main>
  );
}
