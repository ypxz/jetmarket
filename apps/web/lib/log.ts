type Level = "info" | "warn" | "error";

/**
 * Structured JSON-lines logger. One line per event so any log shipper
 * (docker logs → Loki/Datadog/etc.) can parse without config.
 */
export function log(
  level: Level,
  event: string,
  data: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    service: "jetmarket-web",
    vertical: process.env.VERTICAL ?? "jets",
    ...data,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (event: string, data?: Record<string, unknown>) =>
  log("info", event, data);
export const logWarn = (event: string, data?: Record<string, unknown>) =>
  log("warn", event, data);
export const logError = (event: string, data?: Record<string, unknown>) =>
  log("error", event, data);
