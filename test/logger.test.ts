import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

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
