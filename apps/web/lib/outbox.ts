import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Email mock — writes messages to tmp/outbox as JSON. Real impls live in
// packages/providers/email (smtp vs Mailpit, resend skeleton).
export async function sendMail(to: string, subject: string, body: string) {
  const dir = path.join(process.cwd(), "tmp", "outbox");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${to.replace(/[^a-z0-9]/gi, "_")}.json`);
  await writeFile(
    file,
    JSON.stringify({ to, subject, body, sentAt: new Date().toISOString() }, null, 2),
  );
  return { delivered: true, file };
}
