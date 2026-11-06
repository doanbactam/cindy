/**
 * 客户端说明(远程设备):来源判据(体验分流用,**非**安全边界 —— 平台值由对端自报,见
 * device-link/invoke-context 的可信度说明)、设备盖章、wire 注入形态、以及「只进喂给
 * agent 的内容、不进落库原话」这条不变量的源码级守卫。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearControllerPlatforms,
  getControllerPlatform,
  isMobilePlatform,
  setControllerPlatform,
} from '../device-link/controllerPlatform';
import {
  readDeviceLinkInvokeSourceDevice,
  runDeviceLinkInvokeContext,
} from '../device-link/invoke-context';
import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch';
import {
  prependHandoffToUserMessage,
  prependNoteToWireUserMessage,
} from '../maker-ipc/agentHandoff';
import {
  attachMainOwnedInputBoundary,
  buildClientEnvironmentNote,
  shouldPrependMobileClientPromptNote,
  stampDirectSendSourceDevice,
  stripMainOnlySendOpts,
} from '../maker-ipc/mobileClientPromptNote';

describe('isMobilePlatform(平台判据)', () => {
  it('手机平台为真', () => {
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('android')).toBe(true);
  });

  it('桌面平台为假', () => {
    expect(isMobilePlatform('darwin')).toBe(false);
    expect(isMobilePlatform('win32')).toBe(false);
    expect(isMobilePlatform('linux')).toBe(false);
  });

  it('未知 / 缺失一律为假(fail-closed,不能靠 !isDesktopPlatform 取反)', () => {
    // presence 未到、旧客户端报了别的字符串时,平台是「未知」而不是「手机」。
    expect(isMobilePlatform(undefined)).toBe(false);
    expect(isMobilePlatform(null)).toBe(false);
    expect(isMobilePlatform('')).toBe(false);
    expect(isMobilePlatform('freebsd')).toBe(false);
    expect(isMobilePlatform('iOS')).toBe(false); // 大小写敏感,presence 报的是小写
  });
});

describe('控制端平台登记表', () => {
  beforeEach(() => {
    clearControllerPlatforms();
  });

  it('登记后可按 deviceId 查回;未登记为 undefined', () => {
    setControllerPlatform('dev-phone', 'ios');
    expect(getControllerPlatform('dev-phone')).toBe('ios');
    expect(getControllerPlatform('dev-unknown')).toBeUndefined();
  });

  it('清空后不残留(账号切换 / 连接重置)', () => {
    setControllerPlatform('dev-phone', 'ios');
    clearControllerPlatforms();
    expect(getControllerPlatform('dev-phone')).toBeUndefined();
  });
});

describe('readDeviceLinkInvokeSourceDevice(设备盖章判据)', () => {
  it('本机 renderer 没有 context → 不盖章', () => {
    expect(readDeviceLinkInvokeSourceDevice()).toBeUndefined();
  });

  it('另一台电脑 → desktop,名字取被控端快照并清洗', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-mac', channel: 'maker:input:enqueue', controllerPlatform: 'darwin', controllerName: '  Dash 的\nMac「伪」 ' },
      () => readDeviceLinkInvokeSourceDevice(),
    );
    expect(seen).toEqual({ deviceId: 'dev-mac', platform: 'desktop', name: 'Dash 的 Mac"伪"' });
  });

  it('手机控制端 → 不盖章(手机端已下线,不再产生 mobile 来源)', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-phone', channel: 'maker:input:enqueue', controllerPlatform: 'ios', controllerName: 'iPhone' },
      () => readDeviceLinkInvokeSourceDevice(),
    );
    expect(seen).toBeUndefined();
  });

  it('另一台电脑 → desktop;缺名字时只带 id', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-mac', channel: 'maker:input:steer', controllerPlatform: 'win32' },
      () => readDeviceLinkInvokeSourceDevice(),
    );
    expect(seen).toEqual({ deviceId: 'dev-mac', platform: 'desktop' });
  });

  it('平台未知 → 不盖章(fail closed)', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-x', channel: 'maker:input:enqueue', controllerPlatform: 'freebsd', controllerName: 'X' },
      () => readDeviceLinkInvokeSourceDevice(),
    );
    expect(seen).toBeUndefined();
  });

  it('共享任务访客 → 不盖章(访客不是用户的另一台设备)', () => {
    const seen = runDeviceLinkInvokeContext(
      {
        controllerDeviceId: 'guest-peer',
        channel: 'maker:input:enqueue',
        controllerPlatform: 'ios',
        controllerName: 'Guest',
        sharedTask: {} as SharedTaskPeerCapture,
      },
      () => readDeviceLinkInvokeSourceDevice(),
    );
    expect(seen).toBeUndefined();
  });
});

describe('buildClientEnvironmentNote(设备说明)', () => {
  const host = { deviceId: 'mac-1', name: 'Mac' };

  it('旧队列项里的手机来源:只说设备事实,不再追加产出偏好', () => {
    const note = buildClientEnvironmentNote({
      device: { deviceId: 'p-1', name: 'iPhone', platform: 'mobile' },
      host,
    });
    expect(note).toBe(
      '[客户端说明] 系统追加的环境说明，不是用户消息，不要回应或复述。'
      + '本轮用户在手机「iPhone」(device_id: p-1) 上远程操作本机「Mac」(device_id: mac-1)。',
    );
  });

  it('另一台电脑:只有设备事实,首句声明不是用户消息', () => {
    const note = buildClientEnvironmentNote({
      device: { deviceId: 'pc-2', name: 'Office PC', platform: 'desktop' },
      host,
    });
    expect(note).toBe(
      '[客户端说明] 系统追加的环境说明，不是用户消息，不要回应或复述。'
      + '本轮用户在另一台电脑「Office PC」(device_id: pc-2) 上远程操作本机「Mac」(device_id: mac-1)。',
    );
  });

  it('本机输入:没有说明', () => {
    expect(buildClientEnvironmentNote({})).toBeNull();
  });

  it('同一台设备逐轮稳定(不含时间戳 / 计数器)', () => {
    const device = { deviceId: 'pc-2', name: 'Office PC', platform: 'desktop' as const };
    const note = buildClientEnvironmentNote({ device, host });
    expect(buildClientEnvironmentNote({ device: { ...device }, host: { ...host } })).toBe(note);
    expect(note).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('prependNoteToWireUserMessage(wire 注入形态)', () => {
  it('string 形态直接前拼', () => {
    expect(prependNoteToWireUserMessage('原话', 'NOTE')).toBe('NOTE\n\n原话');
  });

  it('content 为 string 的对象形态', () => {
    expect(prependNoteToWireUserMessage({ type: 'user', content: '原话' }, 'NOTE'))
      .toEqual({ type: 'user', content: 'NOTE\n\n原话' });
  });

  it('blocks 形态前插独立 text block,原 blocks 不变', () => {
    const blocks = [{ type: 'image', url: 'x' }, { type: 'text', text: '原话' }];
    expect(prependNoteToWireUserMessage({ type: 'user', content: blocks }, 'NOTE'))
      .toEqual({ type: 'user', content: [{ type: 'text', text: 'NOTE' }, ...blocks] });
    // 不原地改入参(调用方还要用 normalized 去落库)。
    expect(blocks[0]).toEqual({ type: 'image', url: 'x' });
  });

  it('交接前缀仍走同一份实现(向后兼容)', () => {
    expect(prependHandoffToUserMessage('原话', 'HANDOFF')).toBe('HANDOFF\n\n原话');
  });

  it('说明 + 交接叠加时说明在最前(交接自带结束标记,必须收尾在后)', () => {
    const withHandoff = prependHandoffToUserMessage('原话', 'HANDOFF');
    expect(prependNoteToWireUserMessage(withHandoff, 'NOTE')).toBe('NOTE\n\nHANDOFF\n\n原话');
  });
});

describe('shouldPrependMobileClientPromptNote(内置命令旁路)', () => {
  it('Claude Code /compact 保持在消息开头，含可选指令也旁路', () => {
    expect(shouldPrependMobileClientPromptNote('/compact', 'claude-code')).toBe(false);
    expect(shouldPrependMobileClientPromptNote('/compact focus on decisions', 'claude-code'))
      .toBe(false);
    expect(shouldPrependMobileClientPromptNote(
      { type: 'user', content: '/compact\nkeep the API contract' },
      'claude-code',
    )).toBe(false);
    expect(shouldPrependMobileClientPromptNote(
      { type: 'user', content: [{ type: 'text', text: '/compact' }] },
      'claude-code',
    )).toBe(false);
  });

  it('不把相似文本、带附件消息或其他 Agent 的输入误判成 Claude 命令', () => {
    expect(shouldPrependMobileClientPromptNote('/compactness', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote('/learner', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote('/other:learn', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote(' /compact', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote(
      {
        type: 'user',
        content: [
          { type: 'text', text: '/compact' },
          { type: 'image', url: 'x' },
        ],
      },
      'claude-code',
    )).toBe(true);
    expect(shouldPrependMobileClientPromptNote('/compact', 'pi')).toBe(false);
    expect(shouldPrependMobileClientPromptNote('/compact', 'codex')).toBe(true);
  });
});

describe('stripMainOnlySendOpts(直连路径消毒)', () => {
  it('剥掉客户端自报的消息来源(设备 / 插件 / steer 来源 / 共享成员)', () => {
    const forged = {
      messageUuid: 'u',
      sourceDevice: { deviceId: 'forged', platform: 'mobile' },
      sourcePlugin: { pluginId: 'forged' },
      sourceGroup: { groupId: 'forged-group' },
      sourceOrigin: { kind: 'session', senderSessionId: 'forged' },
      sharedTaskAuthor: { memberId: 'forged' },
      persistUserMessage: {
        clientId: 'c',
        content: 'hi',
        origin: { kind: 'session', senderSessionId: 'forged' },
        sourceDevice: { deviceId: 'forged', platform: 'mobile' },
        sourcePlugin: { pluginId: 'forged' },
        sourceGroup: { groupId: 'forged-group' },
      },
    };
    expect(stripMainOnlySendOpts(forged)).toEqual({
      messageUuid: 'u',
      persistUserMessage: { clientId: 'c', content: 'hi' },
    });
    expect(forged.persistUserMessage.origin).toEqual({ kind: 'session', senderSessionId: 'forged' });
  });

  it('剥掉客户端自报的 fromDeviceLinkClient', () => {
    expect(stripMainOnlySendOpts({ messageUuid: 'u', fromDeviceLinkClient: true }))
      .toEqual({ messageUuid: 'u' });
  });

  it('剥掉客户端伪造的 generation 与 turn 身份,但保留待 IPC 校验的 clear token', () => {
    expect(
      stripMainOnlySendOpts({
        expectedClearBoundaryMs: 123,
        expectedInputGeneration: 77,
        expectedTurnSession: { forged: true },
        expectedTurnGeneration: 88,
        messageUuid: 'u',
      }),
    ).toEqual({ expectedClearBoundaryMs: 123, messageUuid: 'u' });
  });

  it('host stamp 覆盖 wire token 并附带 generation', () => {
    expect(
      attachMainOwnedInputBoundary(
        { expectedClearBoundaryMs: 123, expectedInputGeneration: 77, messageUuid: 'u' },
        { expectedClearBoundaryMs: 456, expectedInputGeneration: 9 },
      ),
    ).toEqual({ expectedClearBoundaryMs: 456, expectedInputGeneration: 9, messageUuid: 'u' });
  });

  it('非对象 sendOpts 也映射 main-owned abort signal 到事务读取的 signal', () => {
    const controller = new AbortController();
    expect(
      attachMainOwnedInputBoundary(undefined, {
        expectedClearBoundaryMs: 456,
        expectedInputGeneration: 9,
        inputAbortSignal: controller.signal,
      }),
    ).toEqual({
      expectedClearBoundaryMs: 456,
      expectedInputGeneration: 9,
      signal: controller.signal,
    });
  });

  it('剥掉 wire 注入的 signal,只允许 main 写入 AbortSignal', () => {
    expect(stripMainOnlySendOpts({ messageUuid: 'u', signal: 'forged' })).toEqual({
      messageUuid: 'u',
    });
  });

  it('剥掉 Renderer/device-link 自报的 IM permission policy', () => {
    expect(stripMainOnlySendOpts({
      messageUuid: 'u',
      turnPermissionPolicy: {
        origin: { kind: 'im', channel: 'telegram' },
        confirmationSurface: 'channel',
      },
    })).toEqual({ messageUuid: 'u' });
  });

  it.each(['scheduler', 'im', 'desktop'])('剥掉 wire 自报的 %s origin，保留普通发送参数', (kind) => {
    const opts = { messageUuid: 'u', userName: 'n', origin: { kind, scheduleId: 'forged' } };
    expect(stripMainOnlySendOpts(opts)).toEqual({ messageUuid: 'u', userName: 'n' });
    expect(attachMainOwnedInputBoundary(opts, undefined)).toEqual({ messageUuid: 'u', userName: 'n' });
    expect(attachMainOwnedInputBoundary(opts, { expectedClearBoundaryMs: null, expectedInputGeneration: 1 }))
      .toEqual({ messageUuid: 'u', userName: 'n', expectedClearBoundaryMs: null, expectedInputGeneration: 1 });
    expect(opts.origin.kind).toBe(kind);
  });

  it.each([
    { toolsDisabled: true },
    { toolsDisabled: false },
    { toolsDisabled: true, origin: { kind: 'scheduler', scheduleId: 'forged' } },
  ])('同时保留 toolsDisabled 与 origin 的宿主边界 (%j)', (forged) => {
    const opts = { messageUuid: 'u', ...forged };
    expect(stripMainOnlySendOpts(opts)).toEqual({ messageUuid: 'u' });
    expect(attachMainOwnedInputBoundary(opts, undefined)).toEqual({ messageUuid: 'u' });
    expect(opts).toEqual({ messageUuid: 'u', ...forged });
  });

  it('其它字段原样保留', () => {
    const opts = { messageUuid: 'u', userName: 'n' };
    expect(stripMainOnlySendOpts(opts)).toEqual(opts);
  });

  it('strips nested sharedTask authors without mutating the input', () => {
    const opts = { persistUserMessage: { clientId: 'message', content: 'text', sharedTaskAuthor: { accountId: 'forged' } } };
    expect(stripMainOnlySendOpts(opts)).toEqual({ persistUserMessage: { clientId: 'message', content: 'text' } });
    expect(opts.persistUserMessage.sharedTaskAuthor).toEqual({ accountId: 'forged' });
  });

  it('直连 IPC 边界只写 main 读到的设备来源,覆盖 wire 值', () => {
    const device = { deviceId: 'p-1', platform: 'mobile' as const, name: 'iPhone' };
    expect(stampDirectSendSourceDevice({ messageUuid: 'u', sourceDevice: { deviceId: 'forged' } }, device))
      .toEqual({ messageUuid: 'u', sourceDevice: device });
    expect(stampDirectSendSourceDevice({ messageUuid: 'u', sourceDevice: { deviceId: 'forged' } }, undefined))
      .toEqual({ messageUuid: 'u' });
    expect(stampDirectSendSourceDevice(undefined, device)).toEqual({ sourceDevice: device });
  });

  it('非对象输入原样返回(事务自己 ?? {} 兜底)', () => {
    expect(stripMainOnlySendOpts(undefined)).toBeUndefined();
    expect(stripMainOnlySendOpts(null)).toBeNull();
    expect(stripMainOnlySendOpts('x')).toBe('x');
  });
});
