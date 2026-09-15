import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(sessionCookie, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
