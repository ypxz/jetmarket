import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { sendMail } from "@/lib/outbox";
import { getRepo } from "@/lib/repo";
import { signSession } from "@/lib/auth";

const Body = z.object({
  email: z.string().email(),
  role: z.enum(["buyer", "operator"]).default("buyer"),
});

export async function POST(req: Request) {
  const { data, error } = await parseBody(req, Body);
  if (error) return error;
  const { email, role } = data!;

  const repo = getRepo();
  const adminEmails = (process.env.ADMIN_EMAILS ?? "admin@jetmarket.local")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const resolvedRole = adminEmails.includes(email.toLowerCase()) ? "admin" : role;
  const user = repo.createUser(email, resolvedRole);

  const appUrl = process.env.APP_URL ?? new URL(req.url).origin;
  const link = `${appUrl}/api/auth/callback?token=${encodeURIComponent(signSession(user.id))}`;
  await sendMail(email, "Your JetMarket sign-in link", `Sign in: ${link}`);

  // Mock mode: also return the link so the flow is demoable without outbox access.
  if ((process.env.AUTH_PROVIDER ?? "mock") !== "mock") {
    return err("real auth provider not configured (TODO go-live)", 501);
  }
  return ok({ sent: true, devLink: link, role: resolvedRole });
}
