"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { sendAction } from "@/lib/fetch-action";

/** QA-543: session-authed self-delete ("right to erasure"). One confirm
 *  dialog (the act destroys the mailbox proof itself — no undo), then the
 *  route clears the session cookie and the buyer lands signed-out. */
export function DeleteAccount() {
  const t = useTranslations("account");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="mt-10 rounded-lg border border-danger/40 p-4" data-testid="account-danger-zone">
      <h2 className="text-lg font-semibold text-danger">{t("dangerZone")}</h2>
      <p className="mt-1 text-sm text-muted">{t("deleteBlurb")}</p>
      <span className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          data-testid="account-delete"
          className="rounded-md border border-danger bg-danger px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          onClick={async () => {
            if (!window.confirm(t("deleteConfirm"))) return;
            setPending(true);
            setError(null);
            const e = await sendAction("/api/account/delete", {
              fallback: t("deleteFailed"),
            });
            if (e) {
              setPending(false);
              setError(e);
            } else {
              // Session is dead — land on the public home, not a
              // re-rendered /account that would just bounce to sign-in.
              window.location.href = "/";
            }
          }}
        >
          {pending ? t("deletePending") : t("deleteData")}
        </button>
        {error ? (
          <span className="text-xs text-danger" role="alert">
            {error}
          </span>
        ) : null}
      </span>
    </section>
  );
}
