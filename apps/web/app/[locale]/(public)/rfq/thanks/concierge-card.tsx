"use client";

import { Card, CardBody } from "@jetmarket/ui";
import { readJsonOr } from "@/lib/fetch-json";
import { ConciergeUpsell } from "@/components/concierge-upsell";
import { useEffect, useState } from "react";

interface Props {
  rfqId: string;
  email: string;
  labels: {
    title: string;
    body: string;
    cta: string;
    busy: string;
    done: string;
    error: string;
  };
}

/**
 * Concierge upsell on the post-submit thanks page. The bearer token in the
 * URL fragment both authorizes the state lookup and the purchase — with no
 * token there's nothing to render (the route would 401 anyway).
 */
export function ConciergeCard({ rfqId, email, labels }: Props) {
  const [rfq, setRfq] = useState<{
    concierge: boolean;
    status: string;
  } | null>(null);
  const [noToken, setNoToken] = useState(false);

  useEffect(() => {
    const token =
      new URLSearchParams(window.location.hash.slice(1)).get("t") ??
      new URLSearchParams(window.location.search).get("t");
    if (!token) {
      setNoToken(true);
      return;
    }
    let live = true;
    fetch(`/api/buyer/quotes?email=${encodeURIComponent(email)}`, {
      headers: { "x-rfq-token": token },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const rows = await readJsonOr<{ id: string; concierge?: boolean; status: string }[]>(res, []);
        const hit = rows.find((r) => r.id === rfqId);
        if (live && hit) setRfq({ concierge: !!hit.concierge, status: hit.status });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rfqId, email]);

  if (noToken || !rfq) return null;
  if (!["open", "matched", "quoted"].includes(rfq.status)) return null;

  return (
    <Card className="mt-6" data-testid="concierge-card">
      <CardBody>
        <h2 className="text-lg font-semibold">{labels.title}</h2>
        <p className="mt-1 text-sm text-muted">{labels.body}</p>
        <div className="mt-4">
          <ConciergeUpsell
            rfqId={rfqId}
            buyerEmail={email}
            concierge={rfq.concierge}
            status={rfq.status}
            onApplied={() => setRfq({ ...rfq, concierge: true })}
            labels={labels}
          />
        </div>
      </CardBody>
    </Card>
  );
}
