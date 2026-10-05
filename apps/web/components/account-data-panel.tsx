"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

// QA-559: buyer data-rights panel — /api/account/export and /delete
// (QA-543/544) existed as routes but nothing linked to them, so a buyer's
// only path was knowing the URL. Mounted on /quotes (the emailed-link
// buyer's home) once the mailbox is proven — the same email+bearer pair
// that the routes accept.
export function AccountDataPanel({
  email,
  token,
}: {
  email: string;
  token: string;
}) {
  const t = useTranslations("quotes");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session buyers may have no ?email= in the URL — the routes fall back
  // to user.email, so only include params we actually hold.
  const qs = [
    email ? `email=${encodeURIComponent(email)}` : "",
    token ? `t=${encodeURIComponent(token)}` : "",
  ]
    .filter(Boolean)
    .join("&");

  async function deleteAccount() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/account/delete?${qs}`, {
        method: "POST",
        headers: token ? { "x-rfq-token": token } : {},
      });
      if (!res.ok) {
        setError(tc("error"));
        setBusy(false);
        return;
      }
      setDeleted(true);
    } catch {
      setError(tc("error"));
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <section className="mt-10" data-testid="account-data">
        <p
          className="rounded-md border border-border bg-surface p-4 text-sm"
          data-testid="account-deleted"
        >
          {t("accountDeleted")}
        </p>
      </section>
    );
  }

  return (
    <section className="mt-10" data-testid="account-data">
      <h2 className="text-lg font-semibold">{t("accountData")}</h2>
      <p className="mt-1 text-sm text-muted">{t("accountDataHint")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={`/api/account/export?${qs}`}
          data-testid="account-export"
          className="rounded-md border border-border bg-background px-3 py-1 text-sm"
        >
          {t("exportData")}
        </a>
        <button
          onClick={deleteAccount}
          disabled={busy}
          data-testid={confirming ? "account-delete-confirm" : "account-delete"}
          className="rounded-md border border-danger px-3 py-1 text-sm text-danger disabled:opacity-50"
        >
          {confirming ? t("deleteAccountConfirm") : t("deleteAccount")}
        </button>
        {confirming ? (
          <button
            onClick={() => setConfirming(false)}
            data-testid="account-delete-cancel"
            className="text-xs text-muted underline"
          >
            {t("cancelEdit")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-2 text-xs text-danger"
          data-testid="account-delete-error"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
