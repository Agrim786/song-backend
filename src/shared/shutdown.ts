import { logger } from "./logger.js";

// Finish in-flight work on deploys/scale-downs instead of dropping it.
export function onShutdown(fn: () => Promise<void>) {
  let closing = false;
  const handler = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 30_000).unref();
    try {
      await fn();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}
