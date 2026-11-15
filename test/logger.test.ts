import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, createLoggerFromConfig, createScrubber } from '../src/logger.js';
import { parseConfig } from '../src/config.js';

const SECRET_TOKEN = '123456789:AAFake-Secret_tokenValue';

function createCapture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const lines = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, lines };
}

describe('createLogger', () => {
  it.each([
    ['top-level botToken', { botToken: SECRET_TOKEN }],
    ['top-level BOT_TOKEN', { BOT_TOKEN: SECRET_TOKEN }],
    ['top-level token', { token: SECRET_TOKEN }],
    ['nested config.botToken', { config: { botToken: SECRET_TOKEN } }],
    ['nested env.BOT_TOKEN', { env: { BOT_TOKEN: SECRET_TOKEN } }],
    ['nested err.config.token', { err: { config: { token: SECRET_TOKEN } } }],
  ])('redacts the token in %s', (_label, fields) => {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream);

    logger.info(fields, 'startup');

    const output = JSON.stringify(lines());
    expect(output).not.toContain(SECRET_TOKEN);
    expect(output).toContain('[REDACTED]');
  });

  it('keeps unrelated fields intact', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream);

    logger.info({ botToken: SECRET_TOKEN, userId: 42 }, 'update');

    expect(lines()[0]).toMatchObject({ userId: 42, msg: 'update' });
  });

  it('honours the configured level', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger('warn', stream);

    logger.info('hidden');
    logger.warn('shown');

    expect(lines().map((line) => line.msg)).toEqual(['shown']);
  });
});

describe('secret scrubbing', () => {
  const SECRET_PART = 'AAFake-Secret_tokenValue';
  const URL_WITH_TOKEN = `https://api.telegram.org/bot${SECRET_TOKEN}/sendMessage`;

  function logError(error: unknown): string {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream, { secrets: [SECRET_TOKEN] });
    logger.error({ err: error }, 'failed');
    return JSON.stringify(lines());
  }

  it('removes the token from an error message', () => {
    const output = logError(new Error(`bad token ${SECRET_TOKEN} here`));

    expect(output).not.toContain(SECRET_TOKEN);
    expect(output).toContain('bad token [REDACTED] here');
  });

  it('removes the token from a URL inside an error message', () => {
    const output = logError(new Error(`request to ${URL_WITH_TOKEN} failed`));

    expect(output).not.toContain(SECRET_PART);
    expect(output).toContain('https://api.telegram.org/bot[REDACTED]/sendMessage');
  });

  it('removes the token from the stack', () => {
    const error = new Error('plain message');
    error.stack = `Error: plain message\n    at fetch (${URL_WITH_TOKEN})`;

    const output = logError(error);

    expect(output).not.toContain(SECRET_PART);
    expect(output).toContain('at fetch');
  });

  it('removes the token from a nested cause chain', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: new Error(`inner ${URL_WITH_TOKEN}`) }),
    });

    const output = logError(error);

    expect(output).not.toContain(SECRET_PART);
    expect(output).toContain('inner');
  });

  it('removes the token from a message string and from arbitrary fields', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream, { secrets: [SECRET_TOKEN] });

    logger.info(
      { url: URL_WITH_TOKEN, deep: { a: { b: { c: SECRET_TOKEN } } } },
      `got ${SECRET_TOKEN}`,
    );

    expect(JSON.stringify(lines())).not.toContain(SECRET_PART);
  });

  it('removes every occurrence, not just the first', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream, { secrets: [SECRET_TOKEN] });

    logger.info(`${SECRET_TOKEN} and ${SECRET_TOKEN} and ${SECRET_TOKEN}`);

    expect(lines()[0]?.msg).toBe('[REDACTED] and [REDACTED] and [REDACTED]');
  });

  it('removes the token in its URL-encoded and JSON-escaped spellings', () => {
    const odd = 'id:se"cr\\et/val ue';
    const scrub = createScrubber([odd]);

    expect(scrub(`a ${encodeURIComponent(odd)} b`)).toBe('a [REDACTED] b');
    expect(scrub(`a ${JSON.stringify(odd).slice(1, -1)} b`)).toBe('a [REDACTED] b');
    expect(scrub(`a ${odd} b`)).toBe('a [REDACTED] b');
  });

  it('ignores empty secrets instead of shredding every line', () => {
    const scrub = createScrubber(['']);

    expect(scrub('hello')).toBe('hello');
  });

  it('leaves unrelated output untouched', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger('info', stream, { secrets: [SECRET_TOKEN] });

    logger.info({ userId: 42 }, 'plain message');

    expect(lines()[0]).toMatchObject({ userId: 42, msg: 'plain message' });
  });

  it('createLoggerFromConfig scrubs the configured bot token', () => {
    const { stream, lines } = createCapture();
    const config = parseConfig({ BOT_TOKEN: SECRET_TOKEN, ALLOWED_USER_IDS: '1' });
    const logger = createLoggerFromConfig(config, stream);

    logger.error({ err: new Error(`failed ${URL_WITH_TOKEN}`) }, 'oops');

    expect(JSON.stringify(lines())).not.toContain(SECRET_PART);
  });
});
