/**
 * Minimal branded HTML shell for transactional mail (QA-186). Callers keep a
 * plain `text` body — `html` is an enhancement, so a bad title/URL can never
 * break the email: every interpolated value is entity-escaped.
 */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function brandedEmailHtml(opts: {
  siteName: string;
  title: string;
  /** Each entry renders as a paragraph. */
  paragraphs: string[];
  cta?: { url: string; label: string };
  /** Rendered as <ul> — for multi-link bodies like the access resend. */
  listItems?: string[];
}): string {
  const paragraphs = opts.paragraphs
    .map((p) => `<p style="margin:0 0 12px">${esc(p)}</p>`)
    .join("");
  const list = opts.listItems?.length
    ? `<ul style="margin:0 0 12px;padding-left:18px">${opts.listItems
        .map((i) => `<li style="margin:4px 0">${esc(i)}</li>`)
        .join("")}</ul>`
    : "";
  const cta = opts.cta
    ? `<p style="margin:20px 0 4px"><a href="${esc(opts.cta.url)}" style="display:inline-block;background:#0e7490;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${esc(opts.cta.label)}</a></p>`
    : "";
  return [
    `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a">`,
    `<div style="max-width:560px;margin:0 auto;padding:32px 20px">`,
    `<div style="font-size:20px;font-weight:700;margin-bottom:20px">${esc(opts.siteName)}</div>`,
    `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px 22px;font-size:14px;line-height:1.55">`,
    `<h1 style="font-size:17px;margin:0 0 14px">${esc(opts.title)}</h1>`,
    paragraphs,
    list,
    cta,
    `</div>`,
    `<p style="font-size:12px;color:#64748b;margin-top:16px">${esc(opts.siteName)} — marketplace, not a broker. Contracts stay between buyer and operator.</p>`,
    `</div></body></html>`,
  ].join("");
}
