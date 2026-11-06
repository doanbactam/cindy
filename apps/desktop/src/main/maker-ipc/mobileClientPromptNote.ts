import {
  buildClientDeviceNote,
  type MessageSourceDevice,
  type MessageSourceHostDevice,
} from '@cindy/maker-shared/message-source';

/**
 * 远程设备来源 —— 盖章、透传、以及逐轮追加到**发给 agent 的 wire 消息**上的 `[客户端说明]`。
 *
 * 为什么需要:同一个桌面会话既可能在本机用,也可能被另一台电脑远程控制。
 * 模型无从得知这一轮用户在哪台设备上。说明只陈述事实(哪台设备、操作的是哪台电脑,
 * 名字一律配 id),怎么做交给模型判断。本机输入不盖章,也就没有这段说明。
 *
 * ── 为什么不进 system prompt(重要,别"优化"回去) ─────────────────────────
 * docs/dev-rules/maker-core-and-agent-behavior.md:
 *  - §3.1:prompt cache 命中依赖请求前缀逐字节稳定,**易变内容只能进 per-call
 *    userPrompt 段**。控制端会中途切换(在这台电脑上开的会话,换到另一台电脑继续),放进
 *    system 前缀既拖缓存率,又会在切换后变成陈旧信息反过来误导模型。
 *  - §4:system prompt 任何改动都要仓库维护者显式确认。本机制刻意不碰它。
 * 追加在 wire 消息上,与 IM 渠道说明(hook-control/outbound.buildHookPromptNote)
 * 及引擎交接前缀(agentHandoff.prependHandoffToUserMessage)同一层、同一套语义:
 * **只进喂给 agent 的内容,不进落库/显示的用户消息原话。**
 * 「逐轮」不等于每轮都重复一份:同一原生上下文里内容没变就不再前置(wireNoteMemory.ts),
 * 换窗、原生压缩、/clear 之后整体重发一次——长对话里几十份一模一样的说明只占窗口。
 *
 * 设备来源只用于归属展示与这段说明,**不是**任何信任 / 权限判据。
 */

/**
 * 本轮发给模型的 `[客户端说明]`;本机输入(无设备来源)返回 null。
 * 说明由 `buildClientDeviceNote` 构造,首句声明「不是用户消息」,只说设备事实。
 *
 * 「逐字节稳定」在这里指**对同一台设备稳定**:设备名与 id 不随轮次变化,不含时间戳 /
 * 计数器等易变量;换一台设备操作时说明随之变化,这本来就是它要传达的事实。
 */
export function buildClientEnvironmentNote(params: {
  device?: MessageSourceDevice;
  host?: MessageSourceHostDevice;
}): string | null {
  return params.device ? buildClientDeviceNote(params.device, params.host) : null;
}

function singleTextContent(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part = content[0];
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const { type, text } = part as { type?: unknown; text?: unknown };
  return (
    (type === 'text' || type === 'input_text' || type === 'output_text')
    && typeof text === 'string'
  ) ? text : null;
}

/**
 * 原生命令必须位于消息开头；环境说明不能抢占这个位置。
 * Claude 旁路 /compact 和 Learn 技能调用；Pi 的 slash 输入交由运行时自己的命令发现处理。
 */
export function shouldPrependMobileClientPromptNote(
  message: unknown,
  agentKind: string,
): boolean {
  const text = singleTextContent(message);
  // Pi owns command discovery. Leave slash inputs intact so its runtime can
  // execute installed commands (or treat unknown ones as literal text).
  if (agentKind === 'pi') {
    const content = message && typeof message === 'object'
      ? (message as { content?: unknown }).content : null;
    const parts = Array.isArray(content) ? content : [];
    const firstText = parts.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
    return !(text ?? firstText ?? '').trimStart().startsWith('/');
  }
  if (agentKind !== 'claude-code') return true;
  if (text === null) return true;
  // Learn's exact-path pin is expanded at the provider boundary, where the
  // command must still lead the input. Keep its aliases free of wire notes.
  return !/^\/compact(?:\s|$)/.test(text)
    && !/^\/(?:(?:skill|cindy):)?learn(?:\s|$)/i.test(text.trimStart());
}

/**
 * Main-owned input boundary captured at an IPC entry point.  The generation is
 * intentionally carried alongside the wall-clock clear token: two clears can
 * share the same millisecond timestamp, while the generation still proves that
 * a request started before the later clear.
 */
export interface MainOwnedInputBoundaryStamp {
  expectedClearBoundaryMs: number | null;
  expectedInputGeneration: number;
  /** Main-only cancellation scope; never comes from a device-link payload. */
  inputAbortSignal?: AbortSignal;
}

/**
 * Strip fields that are only valid when constructed by main.  The clear token
 * itself remains a valid controller precondition: the IPC boundary validates it
 * before `attachMainOwnedInputBoundary` replaces it with the authoritative host
 * stamp.  Keeping it when no stamp is available also preserves old test harnesses
 * and non-device-link callers.
 */
export function attachMainOwnedInputBoundary(
  sendOpts: unknown,
  stamp: MainOwnedInputBoundaryStamp | undefined,
): unknown {
  const sanitized = stripMainOnlySendOpts(sendOpts);
  if (!stamp) return sanitized;
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {
      expectedClearBoundaryMs: stamp.expectedClearBoundaryMs,
      expectedInputGeneration: stamp.expectedInputGeneration,
      ...(stamp.inputAbortSignal ? { signal: stamp.inputAbortSignal } : {}),
    };
  }
  return {
    ...(sanitized as Record<string, unknown>),
    expectedClearBoundaryMs: stamp.expectedClearBoundaryMs,
    expectedInputGeneration: stamp.expectedInputGeneration,
    ...(stamp.inputAbortSignal ? { signal: stamp.inputAbortSignal } : {}),
  };
}

const MAIN_ONLY_PERSIST_FIELDS = [
  'botTaskCoordination', 'sharedTaskAuthor', 'origin', 'sourceDevice', 'sourcePlugin', 'sourceGroup',
] as const;
const MAIN_ONLY_SEND_FIELDS = [
  'fromDeviceLinkClient',
  'uiLanguage',
  'classicalStyle',
  'expectedInputGeneration',
  'expectedTurnSession',
  'expectedTurnGeneration',
  'inputAbortSignal',
  'signal',
  'turnPermissionPolicy',
  'toolsDisabled',
  'origin',
  'sourceDevice',
  'sourcePlugin',
  'sourceGroup',
  'sourceOrigin',
  'sharedTaskAuthor',
] as const;

/**
 * 剥掉 sendOpts 里「只允许 main 写」的字段。
 *
 * `turnPermissionPolicy` 同样只能由 Main 的 IM dispatcher 创建；Renderer/device-link
 * 即使伪造相同字段形状，也不能把普通文本升级成已认证 IM 指令。
 *
 * `origin` 只能由宿主 dispatcher / coordinator 构造，wire 不能自报 scheduler
 * 来源并借此恢复历史授权。
 *
 * 消息来源字段(`sourceDevice` / `sourcePlugin` / steer 透传的 `sourceOrigin` /
 * `sharedTaskAuthor`,以及 `persistUserMessage` 里的 `origin` / `sourceDevice` /
 * `sourcePlugin` / `sharedTaskAuthor`)同样只由 main 盖章:它们决定落库标签与发给模型的
 * `[消息来源]` / `[客户端说明]`,客户端自报一律剥掉。直连路径的设备来源由 IPC 边界
 * 按 invoke context 重新盖章。
 *
 * 非对象输入原样返回(事务自己会按 `?? {}` 兜底)。
 */
export function stripMainOnlySendOpts(sendOpts: unknown): unknown {
  if (!sendOpts || typeof sendOpts !== 'object' || Array.isArray(sendOpts)) return sendOpts;
  let opts = sendOpts as Record<string, unknown>;
  const persisted = opts.persistUserMessage;
  if (
    persisted && typeof persisted === 'object' && !Array.isArray(persisted)
    && MAIN_ONLY_PERSIST_FIELDS.some((key) => key in persisted)
  ) {
    const content = { ...(persisted as Record<string, unknown>) };
    for (const key of MAIN_ONLY_PERSIST_FIELDS) delete content[key];
    opts = { ...opts, persistUserMessage: content };
  }
  if (!MAIN_ONLY_SEND_FIELDS.some((key) => key in opts)) return opts;
  const rest = { ...opts };
  for (const key of MAIN_ONLY_SEND_FIELDS) delete rest[key];
  return rest;
}

/**
 * 直连 maker:send / maker:steer 的设备来源盖章:剥掉 wire 值后,只在同账号控制端且
 * 平台已知时写入 main 读到的 `sourceDevice`(返回新对象,不改入参)。
 */
export function stampDirectSendSourceDevice(
  sendOpts: unknown,
  sourceDevice: MessageSourceDevice | undefined,
): unknown {
  const base = sendOpts && typeof sendOpts === 'object' && !Array.isArray(sendOpts)
    ? { ...(sendOpts as Record<string, unknown>) }
    : sendOpts === undefined || sendOpts === null ? {} : undefined;
  if (!base) return sendOpts;
  delete base.sourceDevice;
  if (sourceDevice) base.sourceDevice = { ...sourceDevice };
  return base;
}
