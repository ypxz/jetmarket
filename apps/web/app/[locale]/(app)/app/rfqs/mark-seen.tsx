"use client";

import { useEffect, useRef } from "react";

/**
 * QA-416: stamps the operator's inbox_seen_at once the inbox has rendered —
 * the "New" badge then survives only for rows created after this visit.
 * Renders nothing; fires once per mount.
 */
export function MarkRfqsSeen() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // Fire-and-forget: a failed stamp only means the badge shows again next
    // visit — never worth surfacing to the operator.
    fetch("/api/operator/rfqs/seen", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
