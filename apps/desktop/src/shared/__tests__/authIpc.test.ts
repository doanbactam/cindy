import { describe, expect, it } from 'vitest';

import {
  parseDesktopAccountDeletionConfirmInput,
  parseDesktopAccountKey,
} from '../authIpc';

describe('desktop auth IPC validation', () => {
  it('accepts bounded opaque account keys and rejects malformed values', () => {
    expect(parseDesktopAccountKey('["global","membership-1"]')).toBe('["global","membership-1"]');
    expect(parseDesktopAccountKey('')).toBeNull();
    expect(parseDesktopAccountKey('x'.repeat(513))).toBeNull();
    expect(parseDesktopAccountKey({ accountKey: 'membership-1' })).toBeNull();
  });

});

describe('parseDesktopAccountDeletionConfirmInput', () => {
  it('keeps only a bounded challenge id and verification code', () => {
    expect(
      parseDesktopAccountDeletionConfirmInput({
        challengeId: 'challenge-id',
        code: '123456',
        acknowledged: false,
        receiptToken: 'must-not-cross-renderer-boundary',
      }),
    ).toEqual({ challengeId: 'challenge-id', code: '123456' });
  });

  it('rejects missing, empty, and oversized confirmation fields', () => {
    expect(parseDesktopAccountDeletionConfirmInput(null)).toBeNull();
    expect(parseDesktopAccountDeletionConfirmInput({ challengeId: '', code: '123456' })).toBeNull();
    expect(parseDesktopAccountDeletionConfirmInput({ challengeId: 'id', code: '' })).toBeNull();
    expect(
      parseDesktopAccountDeletionConfirmInput({ challengeId: 'id', code: '12345a' }),
    ).toBeNull();
    expect(
      parseDesktopAccountDeletionConfirmInput({
        challengeId: 'x'.repeat(257),
        code: '123456',
      }),
    ).toBeNull();
  });
});
