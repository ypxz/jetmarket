// Vitest global setup: probe the docker-compose services once so contract
// specs can `inject('stripeMockUp')` / `inject('mailpitUp')` and skip when a
// service isn't running (offline laptops stay green; `pnpm db:up` turns them on).
import { SERVICES, probe } from './contract/services';

export default async function setup({ provide }: { provide: (k: string, v: unknown) => void }) {
  const [stripe, mailpit] = await Promise.all([
    probe(SERVICES.stripeMock.url, SERVICES.stripeMock.probe),
    probe(SERVICES.mailpit.url, SERVICES.mailpit.probe),
  ]);
  provide('stripeMockUp', stripe);
  provide('mailpitUp', mailpit);
  if (!stripe) console.warn('[contract] stripe-mock unreachable at %s — stripe specs skip (run `pnpm db:up`)', SERVICES.stripeMock.url);
  if (!mailpit) console.warn('[contract] mailpit unreachable at %s — mail specs skip (run `pnpm db:up`)', SERVICES.mailpit.url);
}
