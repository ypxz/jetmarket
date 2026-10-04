"use client";

import { Button, Field, Input, Select, Textarea } from "@jetmarket/ui";
import { useRouter } from "@/i18n/navigation";
import { useEffect, useState } from "react";

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
  /** Field-key → default value from the source listing's attributes. */
  prefill?: Record<string, string>;
  /** Shown when a repost stash prefilled the form (QA-410). */
  repostLabel?: string;
  /** Turnstile site key — renders the widget; empty = captcha provider mock/dev. */
  turnstileSiteKey?: string;
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
  prefill,
  repostLabel,
  turnstileSiteKey,
}: RfqFormProps) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A pre-hydration submit posts the uncontrolled form natively — the page
  // route has no POST handler so a fast click 405s instead of creating the
  // RFQ. Disabled-submit waits are also what e2e relies on (QA-245).
  const [ready, setReady] = useState(false);
  // Repost (QA-410): /quotes stashed a previous request's field map under
  // jm-rfq-repost:<listingId>. Read it post-mount (SSR can't see it) and
  // remount the form on it so uncontrolled defaultValues apply.
  const [repost, setRepost] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    try {
      const key = `jm-rfq-repost:${listingId}`;
      const raw = sessionStorage.getItem(key);
      if (raw) {
        sessionStorage.removeItem(key);
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (typeof v === "string" || typeof v === "number")
              clean[k] = String(v);
          }
          setRepost(clean);
        }
      }
    } catch {
      /* corrupt/absent stash — blank form */
    }
  }, [listingId]);

  // Load the Turnstile script only when a site key is configured; the widget
  // injects a hidden `cf-turnstile-response` input into the form on its own.
  useEffect(() => {
    setReady(true);
    if (!turnstileSiteKey) return;
    if (document.querySelector("script[data-turnstile]")) return;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.dataset.turnstile = "1";
    document.head.appendChild(s);
  }, [turnstileSiteKey]);

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
    // The buyer's contact field is whichever field the vertical declares as
    // email-typed — pinned at exactly one per (vertical, listing type) by the
    // verticals test, not hard-coded to a key name (QA-246).
    const emailFieldKey = fields.find((f) => f.type === "email")?.key ?? "email";
    let res: Response;
    try {
      res = await fetch("/api/rfqs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingId,
          buyerEmail: String(fieldsObj[emailFieldKey] ?? ""),
          fields: fieldsObj,
          website: String(fd.get("website") ?? ""),
          captchaToken: String(
            fd.get("cf-turnstile-response") ?? fd.get("captchaToken") ?? "",
          ),
        }),
      });
    } catch {
      // Offline/timeout — the button was spinning forever before (QA-172).
      setBusy(false);
      setError(errorLabel);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      rfqId?: string;
      accessToken?: string;
      error?: string;
    };
    if (!res.ok) {
      setBusy(false);
      setError(res.status === 429 ? rateLimitedLabel : (data.error ?? errorLabel));
      return;
    }
    // Bearer token rides the URL fragment — never reaches server access logs,
    // Referer headers, or proxies (QA-156 extension). /rfq/thanks renders a
    // client link that forwards the same fragment to /quotes.
    const email = encodeURIComponent(String(fieldsObj[emailFieldKey] ?? ""));
    const t = data.accessToken ? `#t=${encodeURIComponent(data.accessToken)}` : "";
    router.push(`/rfq/thanks?id=${data.rfqId}&email=${email}${t}`);
  }

  // Group contiguous fields by their groupKey for visual sections.
  const sections: { group?: string; items: RfqFieldView[] }[] = [];
  for (const f of fields) {
    const last = sections[sections.length - 1];
    if (last && last.group === f.group) last.items.push(f);
    else sections.push({ group: f.group, items: [f] });
  }

  return (
    <form
      key={repost ? "repost" : "fresh"}
      onSubmit={onSubmit}
      className="space-y-6"
      data-testid="rfq-form"
    >
      {repost && repostLabel ? (
        <p
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted"
          data-testid="rfq-repost-note"
        >
          {repostLabel}
        </p>
      ) : null}
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
                      defaultValue={repost?.[f.key] ?? prefill?.[f.key]}
                      data-testid={`rfq-field-${f.key}`}
                    />
                  ) : f.type === "select" ? (
                    <Select
                      id={`rfq-${f.key}`}
                      name={f.key}
                      required={f.required}
                      data-testid={`rfq-field-${f.key}`}
                      defaultValue={repost?.[f.key] ?? prefill?.[f.key] ?? ""}
                    >
                      <option value="" disabled>
                        {f.placeholder ?? "—"}
                      </option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={`rfq-${f.key}`}
                      name={f.key}
                      type={f.type}
                      required={f.required}
                      placeholder={f.placeholder}
                      defaultValue={repost?.[f.key] ?? prefill?.[f.key]}
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
      {/* Captcha — hidden token input for mock mode; Turnstile widget renders
          its own cf-turnstile-response input when a site key is configured. */}
      <input type="hidden" name="captchaToken" value="" />
      {turnstileSiteKey ? (
        <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger" data-testid="rfq-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !ready} data-testid="rfq-submit">
        {busy ? sendingLabel : submitLabel}
      </Button>
    </form>
  );
}
