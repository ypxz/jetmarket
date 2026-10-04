"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { sendAction } from "@/lib/fetch-action";

/**
 * Private operator note on an inbox RFQ row (QA-524) — triage memory
 * that survives the visit ("called this buyer", "suspicious"). Per-operator
 * and never shown anywhere else; an empty save clears it. A quiet link
 * when empty, an italic muted line once set, textarea behind Edit.
 */
export function RfqNote({
  rfqId,
  note: initial,
}: {
  rfqId: string;
  note: string | null;
}) {
  const t = useTranslations("app.rfqs");
  const tc = useTranslations("common");
  const [saved, setSaved] = useState(initial ?? "");
  const [text, setText] = useState(initial ?? "");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    setPending(true);
    try {
      const e = await sendAction(`/api/operator/rfqs/${rfqId}/note`, {
        body: { note: text },
        fallback: tc("error"),
      });
      if (e) {
        setError(e);
        return;
      }
      setError(null);
      // Server trims + treats empty as delete — mirror it locally.
      const stored = text.trim();
      setSaved(stored);
      setText(stored);
      setEditing(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1">
      {saved && !editing ? (
        <p
          className="max-w-md truncate text-xs italic text-muted"
          title={saved}
          data-testid={`rfq-note-${rfqId}`}
        >
          “{saved}”
        </p>
      ) : null}
      {editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t("notePlaceholder")}
            className="w-full max-w-md rounded-md border border-border bg-background px-2 py-1 text-xs"
            data-testid={`rfq-note-input-${rfqId}`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="text-xs text-muted underline"
              data-testid={`rfq-note-save-${rfqId}`}
            >
              {pending ? t("noteWorking") : t("noteSave")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setText(saved);
                setError(null);
              }}
              className="text-xs text-muted underline"
              data-testid={`rfq-note-cancel-${rfqId}`}
            >
              {t("noteCancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-muted underline"
          data-testid={`rfq-note-edit-${rfqId}`}
        >
          {saved ? t("noteEdit") : t("noteAdd")}
        </button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-danger" data-testid={`rfq-note-error-${rfqId}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
