/** Thrown by real provider skeletons for code paths that need live credentials/config. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Real-impl guard: mark a code path as not yet wired for go-live. */
export function todoGoLive(provider: string, what: string, docsUrl: string): ProviderError {
  return new ProviderError(
    `TODO(go-live): ${provider} ${what} is a typed skeleton — wire credentials + verify against the live service.`,
    provider,
    docsUrl,
  );
}
