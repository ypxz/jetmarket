/** Narrow env interface so providers are testable without process.env. */
export type Env = Readonly<Record<string, string | undefined>>;

export function envOf(env?: Env): Env {
  return env ?? process.env;
}
