import { describe, expect, it } from 'vitest';

import { APP_NAME } from '../src/index.js';

describe('toolchain smoke test', () => {
  it('imports TypeScript source through the ESM test runner', () => {
    expect(APP_NAME).toBe('telegram-booking-bot');
  });
});
