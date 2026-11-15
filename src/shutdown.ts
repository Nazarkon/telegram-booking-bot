import type { Logger } from 'pino';

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface ShutdownDeps {
  /**
   * Stops long polling and resolves once the update being processed has finished. Must not
   * resolve earlier: the database is closed right after it.
   */
  readonly stopPolling: () => Promise<void>;
  readonly closeDatabase: () => void;
  readonly logger: Logger;
  readonly exit: (code: number) => void;
}

/**
 * Stops long polling AND waits for the update being processed. `bot.stop()` only cancels the
 * pending `getUpdates` and confirms the offset; it does not wait for middleware. The promise
 * returned by `bot.start()` settles once the polling loop, including the in-flight update, is
 * done, so waiting for it is what lets the current update finish before the database closes.
 */
export function createPollingStopper(
  bot: { stop: () => Promise<void> },
  getPolling: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    // Wait for the polling loop even when stop() fails: the database is closed right after
    // this, so the in-flight update must be done first.
    try {
      await bot.stop();
    } finally {
      await getPolling();
    }
  };
}

/**
 * Builds the shutdown routine: stop polling (the in-flight update finishes), THEN close the
 * database, then exit. It is idempotent: a second signal while (or after) shutting down does
 * nothing. The database is closed even if stopping fails, and the exit code reflects failure
 * (`failureExitCode` is the code to use when the caller is already shutting down because of one).
 */
export function createShutdown(
  deps: ShutdownDeps,
): (reason: string, failureExitCode?: number) => Promise<void> {
  let inProgress: Promise<void> | undefined;

  async function run(reason: string, failureExitCode: number): Promise<void> {
    deps.logger.info({ reason }, 'shutting down');
    let exitCode = failureExitCode;
    try {
      await deps.stopPolling();
    } catch (error) {
      exitCode = 1;
      deps.logger.error({ err: error }, 'failed to stop polling cleanly');
    }
    try {
      deps.closeDatabase();
    } catch (error) {
      exitCode = 1;
      deps.logger.error({ err: error }, 'failed to close the database');
    }
    deps.logger.info({ exitCode }, 'shutdown complete');
    deps.exit(exitCode);
  }

  return (reason, failureExitCode = 0) => {
    inProgress ??= run(reason, failureExitCode);
    return inProgress;
  };
}

/** Subset of `process` the signal wiring needs, so tests can pass a plain EventEmitter. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
}

/** Runs `shutdown` on SIGINT (Fly's default) and on SIGTERM. */
export function registerShutdownSignals(
  source: SignalSource,
  shutdown: (signal: string) => Promise<void>,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    source.on(signal, () => {
      void shutdown(signal);
    });
  }
}
