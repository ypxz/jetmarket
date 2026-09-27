import { NextResponse } from "next/server";
import { logInfo, logWarn } from "@/lib/log";
import { getDbSql } from "@/lib/repo/drizzle";

const payload = (extra?: Record<string, unknown>) => ({
  ok: true,
  service: "jetmarket-web",
  vertical: process.env.VERTICAL ?? "jets",
  time: new Date().toISOString(),
  ...extra,
});

// Shallow liveness by default; when postgres is configured, probe it so a
// wedged pool still fails health (deploy/load-balancer checks).
export async function GET() {
  logInfo("health.check");
  if (!process.env.DATABASE_URL) return NextResponse.json(payload());
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
