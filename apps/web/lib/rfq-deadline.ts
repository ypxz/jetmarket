/** RFQ liveness horizon (QA-442): the exact rule the worker's expireRfqs
 *  sweep enforces, single-sourced so every surface that SHOWS a deadline
 *  (operator inbox, buyer quotes inbox) can't drift from the sweep —
 *  dateTo'd requests live through the travel date and die the next UTC
 *  day; undated/malformed requests die at createdAt + 30d. `dateTo` is the
 *  shared convention field name both impls already hard-code. */
export function rfqDeadlineAt(rfq: {
  createdAt: string;
  fields: Record<string, unknown>;
}): Date {
  const d = rfq.fields["dateTo"];
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    // Live through the date — the sweep flips it once `dateTo < today`.
    const t = new Date(`${d}T00:00:00.000Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t;
  }
  const t = new Date(rfq.createdAt);
  t.setUTCDate(t.getUTCDate() + 30);
  return t;
}
