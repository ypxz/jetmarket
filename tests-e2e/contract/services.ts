// Service probing for contract tests. Global setup (vitest.global-setup.ts)
// fetches each service once and provides reachability via inject(), so specs
// skip cleanly when the docker-compose services are not running.
export const SERVICES = {
  stripeMock: {
    url: process.env.STRIPE_API_BASE ?? 'http://localhost:12111',
    probe: '/v1/charges?limit=1', // stripe-mock answers GETs with fixtures
  },
  mailpit: {
    url: process.env.MAILPIT_API_URL ?? 'http://localhost:8025',
    probe: '/api/v1/messages?limit=1',
  },
} as const;

export type ServiceName = keyof typeof SERVICES;

export async function probe(url: string, path: string, timeoutMs = 3000) {
  try {
    const res = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // any HTTP response (even 4xx) means the service is up
    return res.status > 0;
  } catch {
    return false;
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    stripeMockUp: boolean;
    mailpitUp: boolean;
  }
}
