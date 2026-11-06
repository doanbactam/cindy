import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => {
  // SUPPORTS_MUTE is read once at import time, so the platform must be Windows before the import.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  return { getMuted: vi.fn(), setMuted: vi.fn() };
});
vi.mock('loudness', () => ({ default: audio }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import { SystemAudioMuteGuard } from '../SystemAudioMuteGuard';

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  audio.getMuted.mockReset().mockResolvedValue(false);
  audio.setMuted.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it('reserves output while the OS mute is pending, and releases only after restoration', async () => {
  let finish!: (value: boolean) => void;
  audio.getMuted.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const guard = new SystemAudioMuteGuard();
  expect(guard.hasPendingOrActiveMute).toBe(false);
  const muting = guard.mute(1);
  expect(guard.hasPendingOrActiveMute).toBe(true);
  await vi.waitFor(() => expect(audio.getMuted).toHaveBeenCalledOnce());
  finish(false); await muting;
  expect(guard.hasPendingOrActiveMute).toBe(true);
  await guard.restore(1);
  expect(guard.hasPendingOrActiveMute).toBe(false);
});

it.each(['restore', 'restoreAll'] as const)(
  'retains original audio state after failed %s through a new owner',
  async (method) => {
    const guard = new SystemAudioMuteGuard();
    await guard.mute(1);
    audio.setMuted.mockRejectedValueOnce(new Error('OS unavailable'));
    await expect(method === 'restore' ? guard.restore(1) : guard.restoreAll()).rejects.toThrow(
      'OS unavailable',
    );
    await guard.mute(2);
    await guard.restore(1);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false], [true]]);
    await guard.restore(2);
    expect(audio.getMuted).toHaveBeenCalledTimes(1);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false], [true], [false]]);
  },
);

it('allows a failed last-owner restore to be retried without another mute', async () => {
  const guard = new SystemAudioMuteGuard();
  await guard.mute(1);
  audio.setMuted.mockRejectedValueOnce(new Error('OS unavailable'));
  await expect(guard.restore(1)).rejects.toThrow();
  await guard.restore(1);
  expect(audio.setMuted.mock.calls).toEqual([[true], [false], [false]]);
});

it.each([true, false])(
  'keeps remote and WebContents owners independent, remote first=%s',
  async (remoteFirst) => {
    const guard = new SystemAudioMuteGuard();
    const owners = remoteFirst
      ? ['remote-desktop' as const, 0xc1d0]
      : [0xc1d0, 'remote-desktop' as const];
    await guard.mute(owners[0]);
    await guard.mute(owners[1]);
    await guard.mute(owners[0]);
    await guard.restore(owners[0]);
    await guard.restore(owners[0]);
    expect(audio.getMuted).toHaveBeenCalledTimes(1);
    expect(audio.setMuted.mock.calls).toEqual([[true]]);
    await guard.restore(owners[1]);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false]]);
  },
);

it('rejects mute when the Windows backend cannot load, including cached failures', async () => {
  // reset-modules: the loudness load result is cached in the module-level loudnessCache; the failure path needs a fresh module instance.
  vi.resetModules();
  vi.doMock('loudness', () => {
    throw new Error('module missing');
  });
  const { SystemAudioMuteGuard: FreshGuard } = await import('../SystemAudioMuteGuard');
  const guard = new FreshGuard();
  await expect(guard.mute(1)).rejects.toThrow('SYSTEM_AUDIO_UNAVAILABLE');
  await expect(guard.mute(2)).rejects.toThrow('SYSTEM_AUDIO_UNAVAILABLE');
  expect(audio.getMuted).not.toHaveBeenCalled();
  expect(audio.setMuted).not.toHaveBeenCalled();
});
