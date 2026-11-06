/** Typed renderer/main boundary for the auth-server account lifecycle flows. */
import type {
  AccountDeletionAvailability,
  AccountDeletionStatus,
} from '@cindy/auth-client';

/** The receipt token stays in Electron main; renderer only receives display-safe fields. */
export interface DesktopAccountDeletionChallenge {
  challengeId: string;
  channel: 'email' | 'sms';
  maskedTarget: string;
  expiresAt: string;
}

export interface DesktopAccountDeletionConfirmInput {
  challengeId: string;
  code: string;
}

/** Account-deletion IPC keeps auth-server error codes as structured UI metadata. */
export type DesktopAccountDeletionResult<T> =
  { success: true; value: T } | { success: false; code: string };

export type DesktopAccountDeletionAvailabilityResult =
  DesktopAccountDeletionResult<AccountDeletionAvailability>;
export type DesktopAccountDeletionChallengeResult =
  DesktopAccountDeletionResult<DesktopAccountDeletionChallenge>;
export type DesktopAccountDeletionConfirmResult =
  DesktopAccountDeletionResult<AccountDeletionStatus>;
export type DesktopAccountDeletionStatusResult =
  DesktopAccountDeletionResult<AccountDeletionStatus | null>;

const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_ACCOUNT_KEY_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function parseDesktopAccountKey(value: unknown): string | null {
  return isBoundedString(value, MAX_ACCOUNT_KEY_LENGTH) ? value : null;
}

/** Runtime validation for the irreversible account-deletion confirmation boundary. */
export function parseDesktopAccountDeletionConfirmInput(
  value: unknown,
): DesktopAccountDeletionConfirmInput | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.challengeId, MAX_OPAQUE_ID_LENGTH)) return null;
  if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) return null;
  return { challengeId: value.challengeId, code: value.code };
}
