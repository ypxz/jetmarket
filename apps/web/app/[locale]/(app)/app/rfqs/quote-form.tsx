"use client";

import { readJsonOr } from "@/lib/fetch-json";
import { errText } from "@/lib/error-catalog";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

interface QuoteTemplate {
  id: string;
  name: string;
  amount: number;
  message: string;
}

export function QuoteForm({ rfqId }: { rfqId: string }) {
  const t = useTranslations("app.rfqs");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Hydrated gate — pre-hydration submit posts natively (405). QA-245.
  const [ready, setReady] = useState(false);
  // QA-527: saved quote presets — fetched post-mount so the picker can't
  // post natively; refs (not state) fill the uncontrolled inputs.
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  const amountRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setReady(true);
    fetch("/api/operator/quote-templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: QuoteTemplate[] }) =>
        setTemplates(d.templates ?? []),
      )
      .catch(() => {});
  }, []);

  function applyTemplate(id: string) {
    const tpl = templates.find((x) => x.id === id);
    if (!tpl) return;
    if (amountRef.current) amountRef.current.value = String(tpl.amount);
    if (messageRef.current) messageRef.current.value = tpl.message;
  }

  async function saveTemplate() {
    const name = nameRef.current?.value.trim() ?? "";
    const amount = Number(amountRef.current?.value);
    const message = messageRef.current?.value ?? "";
    setError(null);
    let res: Response;
    try {
      res = await fetch("/api/operator/quote-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, amount, message }),
      });
    } catch {
      setError(t("failed"));
      return;
    }
    const d = await readJsonOr<{ template?: QuoteTemplate; error?: string; code?: string }>(res, {});
    if (!res.ok || !d.template) {
      setError(errText(d, t("failed")));
      return;
    }
    setTemplates((prev) =>
      [...prev.filter((x) => x.name !== d.template!.name), d.template!].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    );
    if (nameRef.current) nameRef.current.value = "";
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    let res: Response;
    try {
      res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rfqId,
          amount: Number(f.get("amount")),
          message: f.get("message"),
        }),
      });
    } catch {
      setSending(false);
      setError(t("failed"));
      return;
    }
    setSending(false);
    if (!res.ok) {
      setError(
        errText(
          await readJsonOr<{ error?: string; code?: string }>(res, {}),
          t("failed"),
        ),
      );
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      {templates.length > 0 ? (
        <select
          aria-label={t("templatePh")}
          defaultValue=""
          onChange={(e) => applyTemplate(e.target.value)}
          data-testid={`quote-template-pick-${rfqId}`}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="" disabled>
            {t("templatePh")}
          </option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      ) : null}
      <input
        name="amount"
        type="number"
        required
        min={1}
        ref={amountRef}
        aria-label={t("amountPh")}
        placeholder={t("amountPh")}
        data-testid={`quote-amount-${rfqId}`}
        className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <input
        name="message"
        ref={messageRef}
        aria-label={t("messagePh")}
        placeholder={t("messagePh")}
        className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={sending || !ready}
        data-testid={`quote-send-${rfqId}`}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {sending ? t("sending") : t("send")}
      </button>
      <input
        ref={nameRef}
        aria-label={t("templateNamePh")}
        placeholder={t("templateNamePh")}
        maxLength={80}
        data-testid={`quote-template-name-${rfqId}`}
        className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
      />
      <button
        type="button"
        disabled={!ready}
        onClick={saveTemplate}
        data-testid={`quote-template-save-${rfqId}`}
        className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
      >
        {t("saveTemplate")}
      </button>
      {error ? <span className="text-sm text-[color:var(--color-danger)]">{error}</span> : null}
    </form>
  );
}
