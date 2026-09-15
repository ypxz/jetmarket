import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "jetmarket-web",
    vertical: process.env.VERTICAL ?? "jets",
    time: new Date().toISOString(),
  });
}
