// Minimal SMTP client for contract tests (dep-free, ~RFC 5321 subset).
// Good enough for Mailpit/local relays: EHLO → MAIL FROM → RCPT TO → DATA → QUIT.
// Other packages can reuse it via `@jetmarket/tests-e2e/contract/smtp`.
import net from 'node:net';

export interface SmtpSendInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** smtp://host:port — defaults to SMTP_URL env or localhost:1025 */
  url?: string;
}

function readReply(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      // multi-line replies end with "<code> <text>" (space, not dash)
      if (/^\d{3} [^\r\n]*\r?\n$/m.test(buf) || /^\d{3} /.test(buf)) {
        socket.off('data', onData);
        resolve(buf);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

export async function smtpSend(input: SmtpSendInput): Promise<void> {
  const url = new URL(input.url ?? process.env.SMTP_URL ?? 'smtp://localhost:1025');
  const socket = net.createConnection({
    host: url.hostname,
    port: Number(url.port || 25),
    timeout: 5000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('smtp connect timeout')));
  });

  const send = async (cmd: string, expectPrefix: string) => {
    socket.write(cmd + '\r\n');
    const reply = await readReply(socket);
    if (!reply.startsWith(expectPrefix)) {
      throw new Error(`SMTP ${cmd.split(' ')[0]} → ${reply.trim()}`);
    }
    return reply;
  };

  try {
    await readReply(socket); // banner
    await send(`EHLO jetmarket-test`, '250');
    await send(`MAIL FROM:<${input.from}>`, '250');
    await send(`RCPT TO:<${input.to}>`, '250');
    await send('DATA', '354');
    const headers = [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      input.text.replace(/\r?\n/g, '\r\n'),
      '',
      '.',
    ].join('\r\n');
    await send(headers, '250');
    await send('QUIT', '221');
  } finally {
    socket.destroy();
  }
}
