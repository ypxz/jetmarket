"use client";

import { Button, Field, Input, Textarea } from "@jetmarket/ui";
import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

export interface RfqFieldView {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "number" | "date" | "select" | "textarea";
  required: boolean;
  group?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

interface RfqFormProps {
  listingId: string;
  fields: RfqFieldView[];
  groupLabels: Record<string, string>;
  submitLabel: string;
  sendingLabel: string;
  errorLabel: string;
  rateLimitedLabel: string;
  honeypotHint: string;
  emailFieldKey: string;
}

/**
 * Buyer RFQ form — rendered entirely from the vertical's rfqFields config.
 * Posts to /api/rfqs (which honeypots + rate-limits + persists via the repo).
 */
export function RfqForm({
  listingId,
  fields,
  groupLabels,
  submitLabel,
  sendingLabel,
  errorLabel,
  rateLimitedLabel,
  honeypotHint,
  emailFieldKey,
}: RfqFormProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const fieldsObj: Record<string, unknown> = {};
    for (const f of fields) {
      const v = fd.get(f.key);
      fieldsObj[f.key] = v === null || v === "" ? "" : String(v);
    }
    const res = await fetch("/api/rfqs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        listingId,
        buyerEmail: String(fieldsObj[emailFieldKey] ?? ""),
        fields: fieldsObj,
        website: String(fd.get("website") ?? ""),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      rfqId?: string;
      error?: string;
    };
    if (!res.ok) {
      setBusy(false);
      setError(res.status === 429 ? rateLimitedLabel : (data.error ?? errorLabel));
      return;
    }
    const email = encodeURIComponent(String(fieldsObj[emailFieldKey] ?? ""));
    router.push(`/rfq/thanks?id=${data.rfqId}&email=${email}`);
  }

  // Group contiguous fields by their groupKey for visual sections.
  const sections: { group?: string; items: RfqFieldView[] }[] = [];
  for (const f of fields) {
    const last = sections[sections.length - 1];
    if (last && last.group === f.group) last.items.push(f);
    else sections.push({ group: f.group, items: [f] });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" data-testid="rfq-form">
      {sections.map((s, i) => (
        <fieldset key={s.group ?? i} className="space-y-4">
          {s.group && groupLabels[s.group] ? (
            <legend className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              {groupLabels[s.group]}
            </legend>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {s.items.map((f) => (
              <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                <Field
                  label={f.label}
                  htmlFor={`rfq-${f.key}`}
                  required={f.required}
                >
                  {f.type === "textarea" ? (
                    <Textarea
                      id={`rfq-${f.key}`}
                      name={f.key}
                      required={f.required}
                      placeholder={f.placeholder}
                      data-testid={`rfq-field-${f.key}`}
                    />
                  ) : (
                    <Input
                      id={`rfq-${f.key}`}
                      name={f.key}
                      type={f.type === "select" ? "text" : f.type}
                      required={f.required}
                      placeholder={f.placeholder}
                      data-testid={`rfq-field-${f.key}`}
                    />
                  )}
                </Field>
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      {/* Honeypot — invisible to humans; bots that fill it get a fake success. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-label={honeypotHint}
        className="hidden"
        data-testid="rfq-honeypot"
      />
      {/* Captcha hook — token wired when packages/providers/captcha lands (T5/T15). */}
      <input type="hidden" name="captchaToken" value="" />

      {error ? (
        <p role="alert" className="text-sm text-danger" data-testid="rfq-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} data-testid="rfq-submit">
        {busy ? sendingLabel : submitLabel}
      </Button>
    </form>
  );
}
