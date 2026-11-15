import { EventEmitter } from 'node:events';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createPollingStopper,
  createShutdown,
  registerShutdownSignals,
  SHUTDOWN_SIGNALS,
} from '../src/shutdown.js';

const silentLogger = pino({ level: 'silent' });

interface Rig {
  readonly events: string[];
  readonly shutdown: (reason: string, failureExitCode?: number) => Promise<void>;
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  readonly finishStopping: () => void;
}

function createRig(options: { stopFails?: boolean; closeFails?: boolean } = {}): Rig {
  const events: string[] = [];
  let finishStopping: () => void = () => undefined;
  const exit = vi.fn<(code: number) => void>((code) => {
    events.push(`exit:${String(code)}`);
  });
  const shutdown = createShutdown({
    stopPolling: () => {
      events.push('stop:begin');
      return new Promise<void>((resolve, reject) => {
        finishStopping = () => {
          events.push('stop:end');
          if (options.stopFails === true) reject(new Error('stop failed'));
          else resolve();
        };
      });
    },
    closeDatabase: () => {
      events.push('close');
      if (options.closeFails === true) throw new Error('close failed');
    },
    logger: silentLogger,
    exit,
  });
  return {
    events,
    shutdown,
    exit,
    finishStopping: () => {
      finishStopping();
    },
  };
}

describe('createShutdown', () => {
  it('stops polling first, closes the database only after the stop finished, then exits 0', async () => {
    const rig = createRig();

    const done = rig.shutdown('SIGINT');
    await Promise.resolve();
    expect(rig.events).toEqual(['stop:begin']);

    rig.finishStopping();
    await done;

    expect(rig.events).toEqual(['stop:begin', 'stop:end', 'close', 'exit:0']);
  });

  it('is idempotent: a second signal while shutting down does nothing', async () => {
    const rig = createRig();

    const first = rig.shutdown('SIGINT');
    const second = rig.shutdown('SIGTERM');
    rig.finishStopping();
    await Promise.all([first, second]);

    expect(rig.events.filter((event) => event === 'stop:begin')).toHaveLength(1);
    expect(rig.events.filter((event) => event === 'close')).toHaveLength(1);
    expect(rig.exit).toHaveBeenCalledTimes(1);
  });

  it('is idempotent after shutdown has completed', async () => {
    const rig = createRig();
    const first = rig.shutdown('SIGTERM');
    rig.finishStopping();
    await first;

    await rig.shutdown('SIGINT');

    expect(rig.events).toEqual(['stop:begin', 'stop:end', 'close', 'exit:0']);
  });

  it('still closes the database and exits non-zero when stopping fails', async () => {
    const rig = createRig({ stopFails: true });

    const done = rig.shutdown('SIGTERM');
    rig.finishStopping();
    await done;

    expect(rig.events).toEqual(['stop:begin', 'stop:end', 'close', 'exit:1']);
  });

  it('exits non-zero when closing the database fails', async () => {
    const rig = createRig({ closeFails: true });

    const done = rig.shutdown('SIGTERM');
    rig.finishStopping();
    await done;

    expect(rig.exit).toHaveBeenCalledWith(1);
  });

  it('keeps a failure exit code the caller asked for', async () => {
    const rig = createRig();

    const done = rig.shutdown('polling-error', 1);
    rig.finishStopping();
    await done;

    expect(rig.exit).toHaveBeenCalledWith(1);
  });
});

describe('registerShutdownSignals', () => {
  it('handles both SIGINT and SIGTERM', () => {
    expect([...SHUTDOWN_SIGNALS].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it.each(['SIGINT', 'SIGTERM'])('%s triggers shutdown exactly once', (signal) => {
    const source = new EventEmitter();
    const shutdown = vi.fn<(reason: string) => Promise<void>>(() => Promise.resolve());
    registerShutdownSignals(source, shutdown);

    source.emit(signal);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(signal);
  });

  it('wires the signals through to the shutdown routine: stop, then close, once, even on a double signal', async () => {
    const rig = createRig();
    const source = new EventEmitter();
    registerShutdownSignals(source, rig.shutdown);

    source.emit('SIGINT');
    source.emit('SIGTERM');
    source.emit('SIGINT');
    rig.finishStopping();
    await vi.waitFor(() => {
      expect(rig.exit).toHaveBeenCalled();
    });

    expect(rig.events).toEqual(['stop:begin', 'stop:end', 'close', 'exit:0']);
  });
});

describe('createPollingStopper', () => {
  it('calls bot.stop() and then waits for the polling loop, so the in-flight update finishes', async () => {
    const events: string[] = [];
    let finishUpdate: () => void = () => undefined;
    const polling = new Promise<void>((resolve) => {
      finishUpdate = () => {
        events.push('update:finished');
        resolve();
      };
    });
    const bot = {
      stop: () => {
        events.push('bot.stop');
        return Promise.resolve();
      },
    };

    const stopped = createPollingStopper(bot, () => polling)().then(() => {
      events.push('stopper:resolved');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['bot.stop']);

    finishUpdate();
    await stopped;

    expect(events).toEqual(['bot.stop', 'update:finished', 'stopper:resolved']);
  });

  it('still waits for the polling loop when bot.stop() fails, then rejects with the stop error', async () => {
    const events: string[] = [];
    let finishUpdate: () => void = () => undefined;
    const polling = new Promise<void>((resolve) => {
      finishUpdate = () => {
        events.push('update:finished');
        resolve();
      };
    });
    const bot = { stop: () => Promise.reject(new Error('nope')) };
    let outcome: unknown = 'pending';

    const stopped = createPollingStopper(bot, () => polling)().then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        events.push('stopper:rejected');
        outcome = error;
      },
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // bot.stop() has already rejected, but the in-flight update is still running.
    expect(outcome).toBe('pending');
    expect(events).toEqual([]);

    finishUpdate();
    await stopped;

    expect(events).toEqual(['update:finished', 'stopper:rejected']);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('nope');
  });
});
