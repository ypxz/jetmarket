import { NextResponse } from "next/server";
import { logWarn } from "@/lib/log";
import { repoBackend } from "@/lib/repo";
import { getDbSql } from "@/lib/repo/drizzle";

const payload = (extra?: Record<string, unknown>) => ({
  ok: true,
  service: "jetmarket-web",
  vertical: process.env.VERTICAL ?? "jets",
  // Which repo the process serves — lets the e2e harness tell a reused
  // dev server apart from the postgres-backed one it asked for (QA-289).
  backend: repoBackend(),
  time: new Date().toISOString(),
  ...extra,
});

// Shallow liveness by default; when postgres is configured, probe it so a
// wedged pool still fails health (deploy/load-balancer checks).
export async function GET() {
  // No per-probe log — a load balancer hits this every few seconds and the
  // lines drown real events. Failures still log via `health.db_failed`.
  if (repoBackend() !== "postgres") return NextResponse.json(payload());
  try {
    await getDbSql()`select 1`;
    return NextResponse.json(payload({ db: "ok" }));
  } catch (e) {
    logWarn("health.db_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { ...payload({ db: "down" }), ok: false },
      { status: 503 },
    );
  }
}
