/**
 * Stable application-session identity shared by auth, local data and secret stores.
 *
 * The mode and the account-free owner are persisted. Cindy account sign-in is
 * removed, so every process runs account-free ('local'). Its owner is the
 * reserved `local-v1`, unless this profile last ran signed in: then auth adopts
 * that verified membership id once (see `adoptAccountFreeDataOwner`) so the
 * user's existing per-owner database, secrets and owner directory stay
 * reachable without moving any data.
 */
import { app } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';

import { createLogger } from './logger.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import type { DataOwnerPushStamp } from '../shared/dataOwnerPush.js';

export type AppSessionMode = 'signed-out' | 'local' | 'cloud';

export interface ActiveAppSession {
  mode: AppSessionMode;
  dataOwnerId: string | null;
  generation: number;
}

/** Backward-compatible name for the canonical Profile model constant. */
export const LOCAL_DATA_OWNER_ID = LOCAL_PROFILE_DATA_OWNER_ID;

/** Filesystem/storage-safe opaque namespace for a data owner. */
export function dataOwnerStorageKey(ownerId: string): string {
  return crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
}

/**
 * Resolve private application state beneath the active owner's namespace.
 * Callers must not silently fall back to the shared userData root: doing so
 * would make signed-out startup or an account switch cross-contaminate data.
 */
export function ownerScopedUserDataPath(...parts: string[]): string {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) {
    // Some services register before authentication settles. Give them an
    // ephemeral process namespace so they can initialize without ever
    // reading or writing a real owner's private state.
    return path.join(app.getPath('temp'), 'cindy-no-session', String(process.pid), ...parts);
  }
  return path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId), ...parts);
}

interface PersistedAppSessionSettings {
  activeMode: AppSessionMode;
  /** Adopted former cloud owner that local mode keeps using; absent means local-v1. */
  accountFreeOwnerId?: string;
}

const log = createLogger('appSessionState');
const DEFAULTS: PersistedAppSessionSettings = { activeMode: 'signed-out' };

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'app-session.json');
}

function normalize(raw: unknown): PersistedAppSessionSettings {
  const activeMode =
    raw && typeof raw === 'object'
      ? (raw as { activeMode?: unknown }).activeMode
      : undefined;
  const accountFreeOwnerId =
    raw && typeof raw === 'object'
      ? (raw as { accountFreeOwnerId?: unknown }).accountFreeOwnerId
      : undefined;
  return {
    activeMode:
      activeMode === 'local' || activeMode === 'cloud' || activeMode === 'signed-out'
        ? activeMode
        : 'signed-out',
    ...(typeof accountFreeOwnerId === 'string' && accountFreeOwnerId.trim()
      ? { accountFreeOwnerId: accountFreeOwnerId.trim() }
      : {}),
  };
}

const store = createOverrideSettingsFile<PersistedAppSessionSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'app session',
});

let active: ActiveAppSession | null = null;
let volatileAccountFreeOwnerId: string | null = null;
let boundaryDepth = 0;
let appSessionCommitBoundaryHook: (() => void) | null = null;
const sessionInvalidationListeners = new Set<() => void>();

/** Cancel owner-bound requests before teardown or a new generation becomes visible. */
export function onAppSessionInvalidated(listener: () => void): () => void {
  sessionInvalidationListeners.add(listener);
  return () => { sessionInvalidationListeners.delete(listener); };
}

function invalidateSessionRequests(): void {
  for (const listener of sessionInvalidationListeners) listener();
}

/**
 * Register synchronous owner-scoped runtime invalidation at the exact commit edge.
 * The hook runs after the commit has been accepted but before the new owner is
 * visible, so stale async work cannot resume into the next owner's process state.
 */
export function setAppSessionCommitBoundaryHook(hook: (() => void) | null): void {
  appSessionCommitBoundaryHook = hook;
}

/** Owner of the account-free session: an adopted former cloud owner, else local-v1. */
export function accountFreeDataOwnerId(): string {
  return volatileAccountFreeOwnerId ?? store.read().accountFreeOwnerId ?? LOCAL_DATA_OWNER_ID;
}

/** The mode persisted by the previous run, before this process commits anything. */
export function readPersistedAppSessionMode(): AppSessionMode {
  return store.read().activeMode;
}

/**
 * Keep a former cloud owner's data reachable after sign-in was removed. Only
 * records the owner; the caller commits the session through the normal owner
 * boundary so the change from the initial local-v1 projection is torn down.
 * `persist: false` keeps a passive shared-userData instance from writing.
 */
export function adoptAccountFreeDataOwner(ownerId: string, opts: { persist: boolean }): void {
  const normalized = ownerId.trim();
  if (!normalized || normalized === LOCAL_DATA_OWNER_ID) return;
  if (opts.persist) store.writePatch({ accountFreeOwnerId: normalized });
  else volatileAccountFreeOwnerId = normalized;
  log.info('adopted former cloud owner for the account-free session', {
    dataOwnerId: normalized,
    persisted: opts.persist,
  });
}

function ensureLoaded(): ActiveAppSession {
  if (active) return active;
  // Cindy account sign-in is removed: every process starts in the account-free
  // local session. A saved signed-out or cloud intent is ignored; the next
  // commit persists 'local'.
  active = {
    mode: 'local',
    dataOwnerId: accountFreeDataOwnerId(),
    generation: 0,
  };
  return active;
}

/** Read the last committed stable session. */
export function getActiveAppSession(): ActiveAppSession {
  return { ...ensureLoaded() };
}

/** Snapshot the owner boundary for a live main → renderer/device-link frame. */
export function getActiveDataOwnerPushStamp(): DataOwnerPushStamp {
  const session = ensureLoaded();
  return {
    dataOwnerId: session.dataOwnerId,
    ownerGeneration: session.generation,
  };
}

/**
 * Opaque key identifying "which account is active right now".
 *
 * Any owner-scoped read or write that spans an `await` must capture this before
 * the wait and re-check it after, then drop the operation when it no longer
 * matches — otherwise account A's data lands in account B's storage or UI.
 * `generation` advances on every mode/owner commit, so the key changes even if
 * the same owner is re-committed.
 *
 * Single source of truth on purpose: this invariant was first fixed per-call-site
 * and each missed call site became its own bug.
 */
export function activeOwnerScopeKey(): string {
  const session = ensureLoaded();
  return `${session.mode}:${session.dataOwnerId ?? 'none'}:${session.generation}`;
}

/**
 * Fail closed while owner-bound runtimes are being torn down or replaced.
 * The returned release function is idempotent so error paths can safely use it
 * from `finally` blocks.
 */
export function beginAppSessionBoundary(): () => void {
  boundaryDepth += 1;
  invalidateSessionRequests();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    boundaryDepth = Math.max(0, boundaryDepth - 1);
  };
}

export function isAppSessionBoundaryPending(): boolean {
  return boundaryDepth > 0;
}

/** Backward-compatible alias for the process-local application transition. */
export function isAppSessionBoundaryLocallyPending(): boolean {
  return boundaryDepth > 0;
}

/**
 * Commit a stable session after its required runtime is ready.
 * Cloud commits require a verified membership id; local uses the account-free owner.
 */
export function commitActiveAppSession(
  mode: AppSessionMode,
  cloudOwnerId?: string | null,
  forceBumpGeneration = false,
): ActiveAppSession {
  const previous = ensureLoaded();
  let dataOwnerId: string | null = null;
  if (mode === 'local') {
    dataOwnerId = accountFreeDataOwnerId();
  } else if (mode === 'cloud') {
    const normalized = cloudOwnerId?.trim();
    if (!normalized) throw new Error('cloud app session requires a verified data owner');
    dataOwnerId = normalized;
  }
  const ownerChanged = previous.mode !== mode || previous.dataOwnerId !== dataOwnerId;

  if (!ownerChanged && !forceBumpGeneration) {
    return { ...previous };
  }

  store.writePatch({ activeMode: mode });
  invalidateSessionRequests();
  if (ownerChanged) appSessionCommitBoundaryHook?.();
  active = {
    mode,
    dataOwnerId,
    generation: previous.generation + 1,
  };
  log.info('stable app session committed', {
    mode,
    dataOwnerId,
    generation: active.generation,
  });
  return { ...active };
}

/** Update only this process after a passive instance signs out or is quarantined. */
export function commitVolatileAppSession(
  mode: AppSessionMode,
  cloudOwnerId?: string | null,
  forceBumpGeneration = false,
): ActiveAppSession {
  const previous = ensureLoaded();
  let dataOwnerId: string | null = null;
  if (mode === 'local') {
    dataOwnerId = accountFreeDataOwnerId();
  } else if (mode === 'cloud') {
    const normalized = cloudOwnerId?.trim();
    if (!normalized) throw new Error('cloud app session requires a verified data owner');
    dataOwnerId = normalized;
  }
  const ownerChanged = previous.mode !== mode || previous.dataOwnerId !== dataOwnerId;
  if (!ownerChanged && !forceBumpGeneration) {
    return { ...previous };
  }
  invalidateSessionRequests();
  if (ownerChanged) appSessionCommitBoundaryHook?.();
  active = {
    mode,
    dataOwnerId,
    generation: previous.generation + 1,
  };
  log.info('volatile app session committed', {
    mode,
    dataOwnerId,
    generation: active.generation,
  });
  return { ...active };
}

export const __testing = { normalize };
