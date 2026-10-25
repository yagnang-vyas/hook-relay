import type { Logger } from './logger.js';

export interface ShutdownStep {
  name: string;
  /** Receives the grace time still available to the whole shutdown. */
  run: (remainingGraceMs: number) => Promise<void> | void;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Total time allowed for in-flight work before it is abandoned. */
  graceMs: number;
  /** Executed in order, so list "stop accepting work" steps before "release resources". */
  steps: ShutdownStep[];
  /** Extra time beyond `graceMs` before the process is forcibly terminated (default 5s). */
  forceExitSlackMs?: number;
  signals?: NodeJS.Signals[];
  /** Injectable for tests. */
  exit?: (code: number) => void;
  target?: Pick<NodeJS.Process, 'on'>;
}

export interface ShutdownHandle {
  shutdown: (reason: string) => Promise<void>;
}

/**
 * Graceful shutdown on SIGTERM/SIGINT: run each step in order within the grace budget, then exit.
 * A second signal exits immediately. Work that is cut off is safe: deliveries it held are
 * recovered when their lease expires.
 */
export function installShutdown(options: ShutdownOptions): ShutdownHandle {
  const { logger, graceMs, steps } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const target = options.target ?? process;
  let started = false;

  async function shutdown(reason: string): Promise<void> {
    if (started) {
      logger.warn({ reason }, 'second shutdown signal received; exiting immediately');
      exit(1);
      return;
    }
    started = true;
    logger.info({ reason, graceMs }, 'shutting down');
    const deadline = Date.now() + graceMs;
    // Backstop in case a step hangs past its budget.
    const backstop = setTimeout(
      () => {
        logger.error('shutdown did not finish in time; forcing exit');
        exit(1);
      },
      graceMs + (options.forceExitSlackMs ?? 5_000),
    );
    backstop.unref();

    let failed = false;
    for (const step of steps) {
      try {
        await step.run(Math.max(0, deadline - Date.now()));
      } catch (err) {
        failed = true;
        logger.error({ err, step: step.name }, 'shutdown step failed');
      }
    }
    clearTimeout(backstop);
    logger.info('shutdown complete');
    exit(failed ? 1 : 0);
  }

  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT']) {
    target.on(signal, () => {
      void shutdown(signal);
    });
  }
  return { shutdown };
}
