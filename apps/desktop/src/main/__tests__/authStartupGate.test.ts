/**
 * awaitWithStartupTimeout 单测 —— 冷启动 auth 黑洞网络护栏的时序编排。
 *
 * 关注点:
 * 1. flow 在时限内 settle:结果 / 异常原样透传,与直接 await 无差异,迟到回调不触发;
 * 2. 超时:返回 onTimeout 兜底值,flow 继续后台运行,迟到 resolve / reject 走对应回调;
 * 3. 迟到 reject 即使不注册 onLateError 也被消化,不产生 unhandled rejection;
 * 4. timeoutMs <= 0 退化为直接 await。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import {
  awaitWithStartupTimeout,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
  resolveColdStartTimeoutRecovery,
} from '../authStartupGate';

describe('awaitWithStartupTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flow 在时限内 resolve:透传结果,不触发超时与迟到回调', async () => {
    const onTimeout = vi.fn(() => 'fallback');
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(Promise.resolve('ok'), {
      timeoutMs: 1000,
      onTimeout,
      onLateResult,
    });
    await expect(p).resolves.toBe('ok');
    // 结果返回后即便时间流逝,超时与迟到回调也不再触发
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onLateResult).not.toHaveBeenCalled();
  });

  it('flow 在时限内 reject:异常原样透传给调用方,不走 onLateError', async () => {
    const onLateError = vi.fn();
    const boom = new Error('boom');
    const p = awaitWithStartupTimeout(Promise.reject(boom), {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateError,
    });
    await expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLateError).not.toHaveBeenCalled();
  });

  it('超时:返回 onTimeout 兜底值;flow 迟到 resolve 时回调 onLateResult', async () => {
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateResult,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('fallback');
    expect(onLateResult).not.toHaveBeenCalled();

    // 模拟黑洞网络恢复后请求迟到完成
    resolveFlow('late-login');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateResult).toHaveBeenCalledWith('late-login');
  });

  it('supports an async timeout recovery before returning the fallback', async () => {
    const flow = new Promise<string>(() => undefined);
    const recovery = vi.fn(async () => {
      await Promise.resolve();
    });
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: async () => {
        await recovery();
        return 'recovered-fallback';
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('recovered-fallback');
    expect(recovery).toHaveBeenCalledOnce();
  });

  it('超时:flow 迟到 reject 时回调 onLateError,rejection 被消化', async () => {
    let rejectFlow!: (err: unknown) => void;
    const flow = new Promise<string>((_r, rej) => {
      rejectFlow = rej;
    });
    const onLateError = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateError,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('fallback');

    const boom = new Error('late boom');
    rejectFlow(boom);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateError).toHaveBeenCalledWith(boom);
  });

  it('超时且未注册 onLateError:迟到 rejection 静默消化,不产生 unhandled rejection', async () => {
    let rejectFlow!: (err: unknown) => void;
    const flow = new Promise<string>((_r, rej) => {
      rejectFlow = rej;
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const p = awaitWithStartupTimeout(flow, {
        timeoutMs: 1000,
        onTimeout: () => 'fallback',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe('fallback');

      rejectFlow(new Error('late boom'));
      // unhandledRejection 在真实微任务/事件循环层面派发,切回真实计时器等一拍
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('超时且 onTimeout 抛错:waiter 收到该错误;flow 迟到 resolve 仍走 onLateResult', async () => {
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const boom = new Error('timeout-fallback-failed');
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => {
        throw boom;
      },
      onLateResult,
    });
    // 先挂上 rejection 断言再推进计时器,避免超时 reject 在 expect 之前变成 unhandled。
    const rejected = expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;

    resolveFlow('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateResult).toHaveBeenCalledWith('late');
  });

  it('timeoutMs <= 0:退化为直接 await,永不超时', async () => {
    const onTimeout = vi.fn(() => 'fallback');
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const p = awaitWithStartupTimeout(flow, { timeoutMs: 0, onTimeout });
    await vi.advanceTimersByTimeAsync(60_000);
    resolveFlow('ok');
    await expect(p).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('ColdStartAuthFallbackRegistry', () => {
  it('returns a pending boundary when the owner transition exceeds the startup deadline', async () => {
    const pendingState = { mode: 'signed-out', ownerBoundaryPending: true } as const;
    const recover = vi.fn(async () => ({ mode: 'signed-out', ownerBoundaryPending: false }));
    const result = await resolveColdStartTimeoutRecovery({
      ownerTransitionPending: true,
      authChangedSinceInitialize: false,
      isStartupFallbackEpoch: () => false,
      timeoutStartEpoch: 7,
      currentEpoch: 7,
      currentState: { mode: 'cloud', ownerBoundaryPending: false },
      pendingState,
      recover,
    });
    expect(result).toEqual(pendingState);
    expect(recover).not.toHaveBeenCalled();
  });

  it('recovers a signed-out owner when no owner transition is pending', async () => {
    const pendingState = { mode: 'signed-out', ownerBoundaryPending: true } as const;
    const currentState = { mode: 'cloud', ownerBoundaryPending: false } as const;
    const recoveredState = { mode: 'signed-out', ownerBoundaryPending: false } as const;
    const recover = vi.fn(async () => recoveredState);
    await expect(resolveColdStartTimeoutRecovery({
      ownerTransitionPending: false,
      authChangedSinceInitialize: false,
      isStartupFallbackEpoch: () => false,
      timeoutStartEpoch: 7,
      currentEpoch: 7,
      currentState,
      pendingState,
      recover,
    })).resolves.toBe(recoveredState);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('preserves an explicit login completed before a sibling startup timeout', async () => {
    const loggedInState = { mode: 'cloud', userId: 'new-owner' } as const;
    const recover = vi.fn(async () => ({ mode: 'signed-out' as const }));

    await expect(resolveColdStartTimeoutRecovery({
      ownerTransitionPending: false,
      authChangedSinceInitialize: false,
      isStartupFallbackEpoch: () => false,
      timeoutStartEpoch: 7,
      currentEpoch: 8,
      currentState: loggedInState,
      pendingState: { mode: 'signed-out', ownerBoundaryPending: true },
      recover,
    })).resolves.toBe(loggedInState);

    expect(recover).not.toHaveBeenCalled();
  });

  it('preserves login completed during async startup prereads before the sibling timeout', async () => {
    const initializeStartEpoch = 7;
    let authStateEpoch = initializeStartEpoch;
    const loggedInState = { mode: 'cloud', userId: 'new-owner' } as const;
    const recover = vi.fn(async () => ({ mode: 'signed-out' as const }));

    // reconcileDesktopActiveAuthSession/loadClientEndpointsForRealm are awaited
    // before the shared refresh starts; login may commit while either is pending.
    authStateEpoch += 1;
    await expect(resolveColdStartTimeoutRecovery({
      ownerTransitionPending: false,
      authChangedSinceInitialize: authStateEpoch !== initializeStartEpoch,
      isStartupFallbackEpoch: () => false,
      timeoutStartEpoch: initializeStartEpoch,
      currentEpoch: authStateEpoch,
      currentState: loggedInState,
      pendingState: { mode: 'signed-out', ownerBoundaryPending: true },
      recover,
    })).resolves.toBe(loggedInState);

    expect(recover).not.toHaveBeenCalled();
  });

  it('preserves a late successful refresh across consecutive renderer startup timeouts', async () => {
    vi.useFakeTimers();
    const registry = new ColdStartAuthFallbackRegistry();
    const flowEpoch = 7;
    let currentEpoch = flowEpoch;
    let committedUser: string | null = null;
    let resolveRefresh!: (user: string) => void;
    const refresh = new Promise<string>((resolve) => {
      resolveRefresh = resolve;
    });
    const recover = () => {
      const previousEpoch = currentEpoch;
      currentEpoch += 1;
      registry.record(previousEpoch, currentEpoch);
      return Promise.resolve('signed-out');
    };

    // Two renderer windows share the same refresh, but each owns a startup timer.
    const primary = awaitWithStartupTimeout(refresh, { timeoutMs: 1000, onTimeout: recover });
    const secondary = awaitWithStartupTimeout(refresh, { timeoutMs: 1500, onTimeout: recover });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(primary).resolves.toBe('signed-out');
    await expect(secondary).resolves.toBe('signed-out');
    expect(currentEpoch).toBe(9);

    resolveRefresh('owner');
    const refreshedUser = await refresh;
    const commit = commitColdStartRefreshIfCurrent({
      registry,
      flowEpoch,
      currentEpoch,
      commit: () => {
        committedUser = refreshedUser;
        return committedUser;
      },
    });

    expect(commit).toEqual({ superseded: false, flowEpoch: 9, value: 'owner' });
    expect(committedUser).toBe('owner');
  });

  it('keeps every unobserved sibling timeout edge until the shared refresh commits', async () => {
    const registry = new ColdStartAuthFallbackRegistry();
    const flowEpoch = 7;
    let currentEpoch = flowEpoch;
    const recover = vi.fn(async () => {
      const fromEpoch = currentEpoch;
      currentEpoch += 1;
      registry.record(fromEpoch, currentEpoch);
      return { mode: 'signed-out' as const };
    });
    const loggedOut = { mode: 'signed-out' as const };

    await expect(resolveColdStartTimeoutRecovery({
      ownerTransitionPending: false,
      authChangedSinceInitialize: false,
      isStartupFallbackEpoch: (epoch) => registry.containsOnlyFallbacks(flowEpoch, epoch),
      timeoutStartEpoch: flowEpoch,
      currentEpoch,
      currentState: loggedOut,
      pendingState: { mode: 'signed-out', ownerBoundaryPending: true },
      recover,
    })).resolves.toEqual(loggedOut);
    await expect(resolveColdStartTimeoutRecovery({
      ownerTransitionPending: false,
      authChangedSinceInitialize: false,
      isStartupFallbackEpoch: (epoch) => registry.containsOnlyFallbacks(flowEpoch, epoch),
      timeoutStartEpoch: flowEpoch,
      currentEpoch,
      currentState: loggedOut,
      pendingState: { mode: 'signed-out', ownerBoundaryPending: true },
      recover,
    })).resolves.toEqual(loggedOut);

    expect(currentEpoch).toBe(9);
    expect(commitColdStartRefreshIfCurrent({
      registry,
      flowEpoch,
      currentEpoch,
      commit: () => 'owner',
    })).toEqual({ superseded: false, flowEpoch: 9, value: 'owner' });
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('does not commit a refresh after an explicit login interrupts the fallback chain', () => {
    const registry = new ColdStartAuthFallbackRegistry();
    registry.record(8, 9);
    const commit = vi.fn(() => 'stale-owner');

    const rejected = commitColdStartRefreshIfCurrent({
      registry,
      flowEpoch: 7,
      currentEpoch: 9,
      commit,
    });
    expect(rejected).toEqual({ superseded: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a later user auth change after consecutive startup fallbacks', () => {
    const registry = new ColdStartAuthFallbackRegistry();
    registry.record(7, 8);
    registry.record(8, 9);
    expect(registry.containsOnlyFallbacks(7, 10)).toBe(false);
  });

  it('accepts the unchanged generation without fallback records', () => {
    const registry = new ColdStartAuthFallbackRegistry();
    expect(registry.containsOnlyFallbacks(7, 7)).toBe(true);
  });
});
