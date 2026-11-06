import { INVOKE_TIMEOUT_OVERRIDES_MS } from './allowlist.js';
import {
  TASK_MIGRATION_CHANNEL,
  TASK_MIGRATION_ESTIMATE_TIMEOUT_MS,
  TASK_MIGRATION_RECEIVE_TIMEOUT_MS,
} from './taskMigration.js';
import type { InvokePayload } from './protocol.js';
import { isRemoteAgentReadInvoke } from './remoteAgent.js';

/** These reads may wait behind current-task work. Not a retry or authorization policy.
 * sessions:list also serves initial loading and recovery probes, so it stays foreground.
 */
const BACKGROUND_INVOKE_CHANNELS = new Set([
  'git-context:pr-refs:list',
  'git-context:pr-status',
  'git-context:mr-status',
  'maker:schedule:list-sidebar-index-runs',
  'maker:usage:device-rows',
  // 远程任务状态栏的定时复查(每 15 秒两次只读);后台任务面板挂载水合同用,可让位于用户操作。
  'maker:session-background-activity',
  'maker:session-background-tasks:list',
  // Next-prompt suggestion after a turn completes: a model request the host answers in
  // ~2 s. Nobody waits on it, so it must not hold a foreground slot while the user sends.
  'maker:predict-prompt',
  // 打字时的 Agent 预热是尽力而为的提示，排在用户正在等待的请求之后。
  'maker:session:prewarm',
]);

export function isBackgroundInvoke(channel: string): boolean {
  return BACKGROUND_INVOKE_CHANNELS.has(channel);
}

/**
 * Writes the person is actively waiting on: sending, steering or stopping a turn and
 * answering an interaction. Every relay round trip costs ~0.5 s, so one of these queued
 * behind a dozen history/list reads is exactly the slowness users feel. Both ends grant
 * them a small admission allowance beyond the ordinary limits (InvokeScheduler on the
 * controller, dispatch admission on the host); nothing here changes authorization,
 * retries or timeouts, and a listed channel still needs its allowlist entry.
 * Queue-management edits (reorder, expand, rename) stay foreground: the UI applies them
 * optimistically and nobody waits on their round trip.
 */
const INTERACTIVE_INVOKE_CHANNELS = new Set([
  'maker:send',
  'maker:abort-session',
  'maker:input:enqueue',
  'maker:input:steer',
  'maker:input:stop',
  'maker:input:resume',
  'maker:input:retry-last-error',
  'maker:input:remove',
  'maker:resolve-interaction',
  'maker:agent-task:stop',
]);

export function isInteractiveInvoke(channel: string): boolean {
  return INTERACTIVE_INVOKE_CHANNELS.has(channel);
}

export type InvokePriority = 'interactive' | 'foreground' | 'background';

/** A caller's background hint never demotes an interactive write. */
export function resolveInvokePriority(channel: string, backgroundHint?: boolean): InvokePriority {
  if (isInteractiveInvoke(channel)) return 'interactive';
  return (backgroundHint ?? isBackgroundInvoke(channel)) ? 'background' : 'foreground';
}

/** Control traffic must not wait behind business operations to maintain a link/lease. */
export function bypassInvokeScheduling(payload: InvokePayload): boolean {
  if (payload.channel === 'device-link:subscribe' || payload.channel === 'device-link:unsubscribe') return true;
  const request = payload.args?.[0];
  return payload.channel === 'device-link:remote-desktop:v1' && !!request &&
    typeof request === 'object' && 'op' in request && request.op === 'heartbeat';
}

export const BOT_GROUP_SEND_TIMEOUT_MS = 180_000;
// MCP Apps Host bounds loading at 90s (connection + discovery + HTML). Leave
// room for response delivery without changing other MCP App operation budgets.
export const MCP_APP_OPEN_TIMEOUT_MS = 120_000;

/**
 * Every action-specific desktop budget `resolveRemoteInvokeTimeoutMs` can return beyond
 * INVOKE_TIMEOUT_OVERRIDES_MS. Hosts size their global orphan/outbox ceilings from both,
 * so a host never gives up before the controller stops waiting.
 */
export const ACTION_INVOKE_TIMEOUTS_MS: readonly number[] = [
  BOT_GROUP_SEND_TIMEOUT_MS,
  MCP_APP_OPEN_TIMEOUT_MS,
  TASK_MIGRATION_ESTIMATE_TIMEOUT_MS,
  TASK_MIGRATION_RECEIVE_TIMEOUT_MS,
];

export function resolveRemoteInvokeTimeoutMs(
  channel: string,
  args?: unknown[],
): number | undefined {
  const appRequest = args?.[1] as { op?: unknown } | undefined;
  if (channel === 'maker:mcp-apps:v1' && appRequest?.op === 'open') return MCP_APP_OPEN_TIMEOUT_MS;
  // Group sends can materialize attachments, upload media and then submit the message.
  // Only this action gets the larger window; a timeout still means an unconfirmed result.
  const groupRequest = args?.[0] as { collectionId?: unknown; actionId?: unknown } | undefined;
  if (channel === 'maker:remote-resources:invoke' && groupRequest?.collectionId === 'bot-groups' && groupRequest.actionId === 'send')
    return BOT_GROUP_SEND_TIMEOUT_MS;
  if (channel === TASK_MIGRATION_CHANNEL) {
    const request = args?.[0];
    const action = request && typeof request === 'object' && 'action' in request ? request.action : undefined;
    if (action === 'receive') return TASK_MIGRATION_RECEIVE_TIMEOUT_MS;
    // Read-only inventory of a large project (dependencies included) can legitimately exceed 30s.
    if (action === 'estimate') return TASK_MIGRATION_ESTIMATE_TIMEOUT_MS;
    return 30_000;
  }
  return INVOKE_TIMEOUT_OVERRIDES_MS[channel];
}

const PEER_RESET_RETRYABLE_READ_CHANNELS = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:sessions:get-many',
  'local-db:conversations:search',
  'local-db:history:messages',
  'local-db:messages:list',
  'local-db:messages:view',
  'local-db:messages:work-details',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
  'local-db:messages:estimatedSessionValue',
  'local-db:recent-workdirs:list',
  'local-db:subagent-runs:list',
  'local-db:subagent-runs:detail',
  'local-db:subagent-runs:transcript',
  'local-db:bots:list',
  'local-db:bots:get',
  'local-db:orca-workflows:get-by-lead',
  'local-db:orca-workflows:get-by-worker-session',
  'local-db:orca-workflows:list-workers-by-lead',
]);

/** Safe to retry after a peer reset; this does not grant permission or allow coalescing. */
/**
 * peer reset 后可重试的边界(按 op 判断)。远程 Agent 的 poll 按游标幂等，重拉不会重复执行；
 * 它的其它 op(open / call / reply / push / close)仍不可重试。
 */
export function isPeerResetRetryableInvoke(channel: string, args?: unknown[]): boolean {
  return isPeerResetRetryableReadChannel(channel) || isRemoteAgentReadInvoke(channel, args);
}

export function isPeerResetRetryableReadChannel(channel: string): boolean {
  return PEER_RESET_RETRYABLE_READ_CHANNELS.has(channel);
}

/**
 * A completed invocation whose result authorization failed is a separate retry
 * boundary from peer reset, snapshot coalescing, and Host DB admission. Keep
 * this list explicit: list/get names do not prove the handler is read-only.
 * Bot and remote-resource reads can provision, migrate, or reconcile data.
 * The session list's derived backfills are guarded/idempotent; the other
 * entries only read stored session state or the active runtime snapshot.
 */
const COMPLETED_INVOKE_RETRYABLE_READ_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:sessions:get-many',
  'local-db:sessions:interrupted-pending',
  'maker:list-active',
]);

export function isCompletedInvokeRetryableReadChannel(channel: string | undefined): boolean {
  return channel !== undefined && COMPLETED_INVOKE_RETRYABLE_READ_CHANNELS.has(channel);
}

const COALESCIBLE_LISTING_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:list',
  'maker:get-capabilities',
  'maker:provider:list',
  'maker:git-safety:get',
  'maker:schedule:list-sidebar-index-runs',
]);

/**
 * Read freshness is independent of retry safety and Host background admission.
 * sessions:get is a read-after-write recovery boundary, so it never shares an
 * earlier read. A fresh list likewise must not join a snapshot begun before a write.
 */
export function canCoalesceRemoteListing(payload: InvokePayload | undefined): payload is InvokePayload {
  if (!payload || !COALESCIBLE_LISTING_CHANNELS.has(payload.channel)) return false;
  const options = payload.args?.[2];
  return !(payload.channel === 'local-db:sessions:list'
    && options && typeof options === 'object' && !Array.isArray(options)
    && (options as { fresh?: unknown }).fresh === true);
}
