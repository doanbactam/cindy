import { describe, expect, it, vi } from 'vitest';
import {
  describeAgentAuthError,
  formatRemoteError,
  isDeviceUnresponsiveRemoteError,
  isTransientRemoteError,
  withTransientRemoteRetry,
} from '../deviceLinkContract.js';

const noSleep = async () => {};

describe('device-link shared contract', () => {
  it('maps agent not-authenticated errors to guidance copy', () => {
    // maker-core 鉴权门禁的固定 message 模板:`<agentKind> not authenticated: <reason>`
    expect(describeAgentAuthError('claude-code not authenticated: no_key'))
      .toContain('还没有配置可用的 API Key');
    expect(describeAgentAuthError('claude-code not authenticated: no_key'))
      .toContain('设置 → 模型供应商');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).toContain('Hana');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).not.toContain('XDMaker');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).toContain('Claude');
    expect(describeAgentAuthError('codex not authenticated: no_credentials'))
      .toContain('尚未登录 Codex');
    // Pi 也走同一模板与映射(codex review):按 reason 引导,标签显示 Pi。
    expect(describeAgentAuthError('pi not authenticated: no_key')).toContain('API Key');
    expect(describeAgentAuthError('pi not authenticated: no_key')).toContain('Pi');
    expect(describeAgentAuthError('claude-code not authenticated: no_oauth')).toContain('账号授权');
    expect(describeAgentAuthError('claude-code not authenticated: no_encryption')).toContain('安全存储');
    expect(describeAgentAuthError('claude-code not authenticated: proxy_not_ready')).toContain('稍候重试');
    // 动态 reason(OAuth 被服务端作废等):按登录失效引导,原始 reason 附在句尾
    expect(describeAgentAuthError('codex not authenticated: oauth_invalidated_refresh'))
      .toContain('（oauth_invalidated_refresh）');
    // 容忍 formatRemoteError / throwIpcError 加的 `[CODE] ` 前缀
    expect(describeAgentAuthError('[IPC_ERROR] claude-code not authenticated: no_key'))
      .toContain('API Key');
    // 非鉴权错误不拦截
    expect(describeAgentAuthError('unknown failure')).toBeNull();
    expect(describeAgentAuthError('')).toBeNull();
    expect(describeAgentAuthError(null)).toBeNull();
  });

  it('preserves structured remote error codes', () => {
    expect(formatRemoteError(Object.assign(new Error('access revoked by target device'), { code: 'ACCESS_REVOKED' })))
      .toBe('[ACCESS_REVOKED] access revoked by target device');
    expect(formatRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' })))
      .toBe('[REMOTE_DISABLED] remote disabled');
    expect(formatRemoteError(new Error('[NOT_CONNECTED] offline'))).toBe('[NOT_CONNECTED] offline');
  });

  it('classifies transient errors and retries only those failures', async () => {
    expect(isTransientRemoteError(new Error('DbClient not ready'))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('client is not ready'), { code: 'NOT_CONNECTED' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('link is reopening'), { code: 'LINK_NOT_OPEN' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('buffer is full'), { code: 'BACKPRESSURE' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }))).toBe(true);
    expect(isTransientRemoteError('[DEVICE_LINK_TIMEOUT] no result')).toBe(true);
    expect(isTransientRemoteError('[DEVICE_LINK_BUSY] queue full')).toBe(true);
    // HTTP 层弱网错误(超时 / 离线 / RN 原生 fetch 原文)同属瞬时,必须可重试
    expect(isTransientRemoteError(Object.assign(new Error('请求超时，请稍后重试'), { code: 'REQUEST_TIMEOUT' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('网络连接不可用'), { code: 'NETWORK_UNAVAILABLE' }))).toBe(true);
    expect(isTransientRemoteError(new TypeError('Network request failed'))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' }))).toBe(false);
    expect(isTransientRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x' not allowed")).toBe(false);
    expect(isTransientRemoteError(new Error('unexpected'))).toBe(false);
    // 熔断快速失败必须是 permanent:归为瞬时会让 withTransientRemoteRetry 把
    // 本地直拒再重试 6 次,熔断等于白做。code 与 message 两种形态都要拦住。
    expect(isTransientRemoteError(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    )).toBe(false);
    expect(isTransientRemoteError('[DEVICE_UNRESPONSIVE] target device dev-1 is unresponsive')).toBe(false);

    const op = vi.fn()
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockRejectedValueOnce(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }))
      .mockResolvedValueOnce('ok');

    await expect(withTransientRemoteRetry(op, { sleep: noSleep })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);

    const permanent = vi.fn().mockRejectedValue(new Error('[REMOTE_DISABLED] remote control disabled'));
    await expect(withTransientRemoteRetry(permanent, { sleep: noSleep })).rejects.toThrow('remote control disabled');
    expect(permanent).toHaveBeenCalledTimes(1);

    // 熔断快速失败不重试:一次上抛,让调用方走降级路径
    const unresponsive = vi.fn().mockRejectedValue(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    );
    await expect(withTransientRemoteRetry(unresponsive, { sleep: noSleep })).rejects.toThrow('unresponsive');
    expect(unresponsive).toHaveBeenCalledTimes(1);
  });

  it('recognizes device-unresponsive breaker fast-fails', () => {
    expect(isDeviceUnresponsiveRemoteError(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    )).toBe(true);
    expect(isDeviceUnresponsiveRemoteError('[DEVICE_UNRESPONSIVE] target device dev-1 is unresponsive')).toBe(true);
    expect(isDeviceUnresponsiveRemoteError(new Error('[DEVICE_UNRESPONSIVE] fast fail'))).toBe(true);
    expect(isDeviceUnresponsiveRemoteError(new Error('unexpected'))).toBe(false);
    expect(isDeviceUnresponsiveRemoteError(Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' }))).toBe(false);
  });
});
