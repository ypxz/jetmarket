import { NextResponse } from "next/server";
import { logInfo } from "@/lib/log";

export function GET() {
  logInfo("health.check");
  return NextResponse.json({
    ok: true,
    service: "jetmarket-web",
    vertical: process.env.VERTICAL ?? "jets",
    time: new Date().toISOString(),
  });
}
