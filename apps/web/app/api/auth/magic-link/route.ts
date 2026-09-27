import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { emailProvider } from "@jetmarket/providers";
import { signMagicLink } from "@/lib/auth";

const Body = z.object({
  email: z.string().email(),
  role: z.enum(["buyer", "operator"]).default("buyer"),
});

export async function POST(req: Request) {
  const { data, error } = await parseBody(req, Body);
  if (error) return error;
  const { email, role } = data!;

  // Only mock auth exists — check before doing any work so a real-provider
  // deploy doesn't rate-burn or mail a link for a request we then 501.
  if ((process.env.AUTH_PROVIDER ?? "mock") !== "mock") {
    return err("real auth provider not configured (TODO go-live)", 501);
  }

  // Per-IP + per-inbox: the link email is the spam vector.
  if (
    !rateLimit(`ml:${clientIp(req)}`, 30, 60 * 60 * 1000) ||
    !rateLimit(`ml:${email.toLowerCase()}`, 10, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }

  const repo = await getRepo();
  const adminEmails = (process.env.ADMIN_EMAILS ?? "admin@jetmarket.local")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const resolvedRole = adminEmails.includes(email.toLowerCase()) ? "admin" : role;
  const user = await repo.createUser(email, resolvedRole);

  const appUrl = process.env.APP_URL ?? new URL(req.url).origin;
  const link = `${appUrl}/api/auth/callback?token=${encodeURIComponent(signMagicLink(user.id))}`;
  await emailProvider().send({
    to: email,
    subject: "Your JetMarket sign-in link",
    text: `Sign in: ${link}`,
  });

  // Mock mode: also return the link so the flow is demoable without outbox access.
  return ok({ sent: true, devLink: link, role: resolvedRole });
}
