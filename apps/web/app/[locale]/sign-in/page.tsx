"use client";

import { readJsonOr } from "@/lib/fetch-json";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export default function SignInPage() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  // QA-493: the sign-in mail keeps the page locale — API routes sit outside
  // the intl middleware, so the form stamps it explicitly.
  const locale = useLocale();
  // Hydrated gate — a pre-hydration submit posts the uncontrolled form
  // natively (405); same fix as /quotes and the RFQ form (QA-245).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"buyer" | "operator">("buyer");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const error = useSearchParams().get("error");
  const errorMsg =
    error === "invalid-token"
      ? t("errors.invalidToken")
      : error === "rate-limited"
        ? t("errors.rateLimited")
        : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailed(false);
    let res: Response;
    try {
      res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, locale }),
      });
    } catch {
      setFailed(true);
      return;
    }
    const data = await readJsonOr<{ devLink?: string }>(res, {});
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setDevLink(data.devLink ?? null);
    setSent(true);
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("loginTitle")}</h1>
      <p className="mt-2 text-sm text-muted">{t("noPassword")}</p>
      {errorMsg ? (
        <p
          className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="alert"
          data-testid="signin-error"
        >
          {errorMsg}
        </p>
      ) : null}
      {failed ? (
        <p
          className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="alert"
          data-testid="signin-failed"
        >
          {tc("error")}
        </p>
      ) : null}
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
              data-testid="signin-role-buyer"
            />
            {t("buyer")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={role === "operator"}
              onChange={() => setRole("operator")}
              data-testid="signin-role-operator"
            />
            {t("operator")}
          </label>
        </div>
        <button
          type="submit"
          disabled={!ready}
          data-testid="signin-submit"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
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
      {/* Demo hint — dev/mock only. In production this would hand every
          visitor the seeded admin address (QA-387). */}
      {process.env.NODE_ENV !== "production" ? (
        <p className="mt-8 text-xs text-muted">
          {t("adminTip", { email: "admin@jetmarket.local" })}
        </p>
      ) : null}
    </main>
  );
}
