"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readJsonOr } from "@/lib/fetch-json";

interface SavedSearch {
  id: string;
  params: Record<string, unknown>;
  status: "pending" | "active" | "off";
  freq: "instant" | "daily";
  createdAt: string;
}

// Buyer-side saved-search management (QA-405): mounted only after the
// buyer proved their RFQ bearer token, reusing it to list the mailbox's
// alerts. Alert bearer tokens stay server-side — rows are addressed by
// id and turned off through the session-authed POST.
export function SavedSearchesList({
  email,
  token,
}: {
  email: string;
  token: string;
}) {
  const t = useTranslations("quotes");
  const tc = useTranslations("common");
  const [rows, setRows] = useState<SavedSearch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/buyer/search-alerts?email=${encodeURIComponent(email)}`,
          { headers: { "x-rfq-token": token } },
        );
        if (!res.ok || dead) return;
        const data = await readJsonOr<SavedSearch[]>(res, []);
        if (!dead) setRows(data);
      } catch {
        /* non-fatal: the inbox still works without this section */
      }
    })();
    return () => {
      dead = true;
    };
  }, [email, token]);

  async function turnOff(id: string) {
    setBusy(id);
    setErr(null);
    try {
      const res = await fetch(
        `/api/search-alerts/${id}/off?email=${encodeURIComponent(email)}`,
        { method: "POST", headers: { "x-rfq-token": token } },
      );
      if (!res.ok) {
        setErr(tc("error"));
        return;
      }
      setRows(
        (prev) =>
          prev?.map((a) => (a.id === id ? { ...a, status: "off" } : a)) ??
          prev,
      );
    } catch {
      setErr(tc("error"));
    } finally {
      setBusy(null);
    }
  }

  if (!rows || rows.length === 0) return null;

  return (
    <section className="mt-8" data-testid="saved-searches">
      <h2 className="text-lg font-semibold">{t("alertsTitle")}</h2>
      {err ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {err}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {rows.map((a) => {
          const watch =
            typeof a.params.watch === "string" ? a.params.watch : null;
          const qs = new URLSearchParams();
          if (!watch) {
            for (const [k, v] of Object.entries(a.params)) {
              for (const x of Array.isArray(v) ? v : [v])
                qs.append(k, String(x));
            }
          }
          const href = watch ? `/listing/${watch}` : `/search?${qs.toString()}`;
          return (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
              data-testid={`saved-search-${a.id}`}
            >
              <div className="min-w-0">
                <span className="text-xs text-muted">
                  {t(`alertState.${a.status}`)} · {t(`alertFreq.${a.freq}`)} ·{" "}
                </span>
                <span className="break-all text-muted">
                  {watch
                    ? t("alertWatch")
                    : Object.entries(a.params)
                        .map(([k, v]) =>
                          `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`,
                        )
                        .join(" · ") || t("alertsAll")}
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <a
                  href={href}
                  className="text-xs underline underline-offset-4"
                  data-testid={`saved-search-open-${a.id}`}
                >
                  {watch ? t("alertOpenListing") : t("alertOpen")}
                </a>
                {a.status !== "off" ? (
                  <button
                    onClick={() => turnOff(a.id)}
                    disabled={busy !== null}
                    className="rounded-md border border-border bg-background px-2 py-0.5 text-xs disabled:opacity-50"
                    data-testid={`saved-search-off-${a.id}`}
                  >
                    {t("alertOff")}
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
