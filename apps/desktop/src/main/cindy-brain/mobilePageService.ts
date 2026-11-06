import { createHash, randomUUID } from 'node:crypto';
import {
  PLUGIN_COLLECTION,
  type PluginPagePoll,
  type PluginPageAsset,
  type PluginPageFile,
  PLUGIN_SETTINGS_ACTION,
  type PluginSettingsRequest,
  type PluginOauthAction,
  type RemoteCollectionItem,
} from '@cindy/device-link';
import { ghostContentKeys, ghostFallbackDisplayAuthor, ghostInstallApprovalToken, ghostPermissionItems, ghostTrustLabelKey, type InstalledGhost } from '../../shared/ghost.js';
import { getRemoteOauthContext, notifyOauthCardClosed } from '../plugin-oauth/context.js';
import type { OauthCardBinding } from '../plugin-oauth/transactions.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { resolvePreferredSystemLocale } from '../../shared/locale.js';
import { t } from '../i18n.js';
import type { GhostConfirmShowParams } from './confirmSlot.js';
import type { PluginModelPickerTarget } from './ghostModelPicker.js';
import {
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../device-link/remoteResourceRegistry.js';

interface Page {
  desktopSettings?: true;
  modelPickerRemoteSources?: boolean;
  documentEpoch?: number;
  documentId?: string;
  documentSources?: Set<string>;
  channels?: string[];
  authorizations?: Map<string, { path: string; body?: string; running: boolean; keepAlive?: () => boolean; result?: import('@cindy/device-link').PluginPageFetchResult }>;
  id: string;
  controller: string;
  plugin: string;
  revision: string;
  currentOwner(): boolean;
  currentController(): boolean;
  touchedAt: number;
  files: PluginPageFile[];
  confirms: Map<
    string,
    {
      value: PluginPagePoll['confirms'][number];
      answer(value: boolean): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  notices: PluginPagePoll['notifications'];
  directory?: {
    value: import('@cindy/device-link').PluginDirectoryRequest;
    answer(value: string | null): void;
    timer: ReturnType<typeof setTimeout>;
    answering: boolean;
  };
  directoryAnswers?: Map<string, string>;
  modelPicker?: { value: NonNullable<PluginPagePoll['modelPickers']>[number]; cancel(): void };
}
interface Dependencies {
  management?: import('./remotePluginManagement.js').RemotePluginManagement;
  list(): InstalledGhost[];
  revision(ghost: InstalledGhost): string;
  captureOwner(): () => boolean;
  captureController(controllerId: string): () => boolean;
  bundle(ghost: InstalledGhost, entry: string): Promise<PluginPageFile[]>;
  asset(ghost: InstalledGhost, file: PluginPageFile, offset: number): Promise<PluginPageAsset>;
  connect(ghost: InstalledGhost, pageId: string, channels: string[]): Promise<void>;
  post(ghost: InstalledGhost, pageId: string, channel: string, data: unknown, sourceId?: string): Promise<void>;
  poll(ghost: InstalledGhost, pageId: string, after: number): Promise<PluginPagePoll['events']>;
  disconnect(pluginId: string, pageId: string): Promise<void>;
  settingsFetch?(ghost: InstalledGhost, path: string, method: string, body: string | undefined, current: () => boolean, confirmConnection?: (label: string, host: string) => Promise<boolean>): Promise<import('@cindy/device-link').PluginPageFetchResult>;
  validateDirectory?(path: string): Promise<string>;
  now?(): number;
  answerModelPicker?(pageId: string, requestId: string, route: unknown): Promise<{ handled: boolean; accepted: boolean }>;
}

const fail = (message = 'Plugin page is no longer available'): never => {
  throw new RemoteResourceRegistryError('NOT_FOUND', message);
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Remote plugin settings pages opened by another desktop, plus the `plugins` collection.
 * A page lease belongs to one authenticated controller, account and installed revision.
 * Writes are never replayed after reconnect. */
export class MobilePluginPages {
  private readonly pages = new Map<string, Page>();
  // Retired document IDs remain notice-only until the lease closes.
  private readonly documentSources = new Map<string, Page>();
  private source(id: string): Page | undefined {
    const page = this.pages.get(id) ?? this.documentSources.get(id);
    return page && (page.documentId ?? page.id) === id ? page : undefined;
  }
  constructor(private readonly deps: Dependencies) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private ghost(id: string) {
    return this.deps.list().find((g) => installedGhostStoragePart(g) === id) ?? fail();
  }
  private check(page: Page, enabled = true): InstalledGhost {
    const ghost = this.ghost(page.plugin);
    if (
      !page.currentOwner() ||
      !page.currentController() ||
      this.deps.revision(ghost) !== page.revision ||
      (enabled && !ghost.enabled)
    ) {
      this.close(page);
      return fail();
    }
    return ghost;
  }
  private idleExpired(page: Page): boolean {
    return this.now() - page.touchedAt > 120_000 &&
      ![...(page.authorizations?.values() ?? [])].some(a => a.running && a.keepAlive?.());
  }
  private page(id: unknown, controller: string): Page {
    if (typeof id !== 'string') return fail();
    const page = this.pages.get(id);
    if (!page || page.controller !== controller) return fail();
    if (this.idleExpired(page)) {
      this.close(page);
      return fail();
    }
    this.check(page);
    page.touchedAt = this.now();
    return page;
  }
  private close(page: Page) {
    this.pages.delete(page.id);
    for (const id of page.documentSources ?? []) this.documentSources.delete(id);
    for (const id of page.authorizations?.keys() ?? []) notifyOauthCardClosed(id);
    this.cancelDirectory(page);
    page.modelPicker?.cancel();
    for (const pending of page.confirms.values()) {
      clearTimeout(pending.timer);
      pending.answer(false);
    }
    page.confirms.clear();
    void this.deps.disconnect(page.plugin, page.id).catch(() => {});
  }
  invalidate() {
    for (const page of this.pages.values()) {
      try {
        this.check(page);
      } catch {
        this.close(page);
      }
    }
  }
  settingsBinding(action: PluginOauthAction): OauthCardBinding | null {
    if (action.actionId !== PLUGIN_SETTINGS_ACTION || action.expectedRevision !== 0) return null;
    const page = this.pages.get(action.requestId);
    if (!page?.desktopSettings) return null;
    return {
      ghostId: page.plugin,
      controllerDeviceId: page.controller,
      settingsPage: true,
      current: () => {
        try {
          this.page(page.id, page.controller);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  settingsAuthorizationBinding(action: PluginOauthAction): OauthCardBinding | null {
    if (action.actionId !== 'settings-oauth' || action.expectedRevision !== 0) return null;
    const page = [...this.pages.values()].find(
      (p) => p.desktopSettings && p.authorizations?.has(action.requestId),
    );
    if (!page) return null;
    return {
      ghostId: page.plugin,
      controllerDeviceId: page.controller,
      current: () => {
        try {
          this.page(page.id, page.controller);
          return page.authorizations!.has(action.requestId);
        } catch {
          return false;
        }
      },
    };
  }
  runSettingsAuthorization(action: PluginOauthAction): boolean {
    const binding = this.settingsAuthorizationBinding(action),
      remote = getRemoteOauthContext();
    if (!binding?.current() || !remote || remote.peer !== binding.controllerDeviceId) return false;
    const page = [...this.pages.values()].find((p) => p.authorizations?.has(action.requestId))!;
    const authorization = page.authorizations!.get(action.requestId)!;
    if (authorization.running) return false;
    const ghost = this.check(page);
    authorization.running = true;
    // Only the already-bound transaction can retain this page while the phone is away.
    // A missing deadline preserves the legacy idle policy. Identity checks still run.
    authorization.keepAlive = () => remote.expiresAt !== undefined &&
      this.now() < remote.expiresAt && !remote.cancelled?.aborted;
    void (async () => {
      try {
        // The original endpoint owns OAuth validation, exchange and persistence.
        const result = await this.deps.settingsFetch!(
          ghost,
          authorization.path,
          'POST',
          authorization.body,
          binding.current,
        );
        if (!binding.current()) throw new Error('PLUGIN_PAGE_CLOSED');
        authorization.result = result;
        remote.finish(
          result.status === 200 &&
            JSON.parse(Buffer.from(result.base64, 'base64').toString()).ok === true,
        );
      } catch {
        if (binding.current())
          authorization.result = {
            status: 200,
            mime: 'application/json',
            base64: Buffer.from(JSON.stringify({ ok: false, error: 'CANCELLED' })).toString(
              'base64',
            ),
          };
        remote.finish(false);
      } finally {
        authorization.keepAlive = undefined;
        authorization.body = undefined;
      }
    })();
    return true;
  }
  async settingsRequest(controller: string, request: PluginSettingsRequest): Promise<unknown> {
    const page = this.page(request.id, controller);
    if (!page.desktopSettings) return fail();
    const ghost = this.check(page),
      command = request.command,
      sourceId = page.documentId ?? page.id;
    const current = () => {
      try {
        return this.page(page.id, controller) === page;
      } catch {
        return false;
      }
    };
    const done = <T>(value: T): T => {
      if (!current()) return fail();
      return value;
    };
    switch (command.kind) {
      case 'document': {
        if (command.epoch < (page.documentEpoch ?? 0)) return fail();
        if (command.epoch === page.documentEpoch) return {};
        // Bound retained notice origins within this lease; a reload opens a fresh lease.
        if ((page.documentSources?.size ?? 0) >= 1024) return fail();
        page.documentEpoch = command.epoch;
        page.documentId = randomUUID();
        (page.documentSources ??= new Set()).add(page.documentId);
        this.documentSources.set(page.documentId, page);
        this.cancelDirectory(page);
        page.modelPicker?.cancel();
        for (const pending of page.confirms.values()) {
          clearTimeout(pending.timer);
          pending.answer(false);
        }
        page.confirms.clear();
        page.directoryAnswers?.clear();
        return {};
      }
      case 'close':
        this.close(page);
        return {};
      case 'asset': {
        const file = page.files.find((f) => f.path === command.path);
        if (!file || command.offset > file.size) return fail();
        return done(await this.deps.asset(ghost, file, command.offset));
      }
      case 'subscribe': {
        const channels = [...new Set([...(page.channels ?? []), ...command.channels])];
        if (channels.length > 16) return fail();
        await this.deps.connect(ghost, page.id, channels);
        page.channels = channels;
        return done({});
      }
      case 'post':
        if (!page.channels?.includes(command.channel)) return fail();
        await this.deps.post(ghost, page.id, command.channel, command.data, sourceId);
        return done({});
      case 'unsubscribe': {
        const channels = (page.channels ?? []).filter((name) => name !== command.channel);
        await this.deps.connect(ghost, page.id, channels);
        page.channels = channels;
        return done({});
      }
      case 'poll': {
        const events = page.channels?.length ? await this.deps.poll(ghost, page.id, command.after) : [];
        const sameDocument = sourceId === (page.documentId ?? page.id);
        return done({
          events: sameDocument ? events : [],
          confirms: sameDocument ? [...page.confirms.values()].map((p) => p.value) : [],
          notifications: page.notices.splice(0),
          directories: sameDocument && page.directory ? [page.directory.value] : [],
          modelPickers: sameDocument && page.modelPicker ? [page.modelPicker.value] : [],
        });
      }
      case 'confirm': {
        const pending = page.confirms.get(command.requestId);
        if (!pending || pending.value.expiresAt <= this.now()) return fail();
        clearTimeout(pending.timer);
        page.confirms.delete(command.requestId);
        pending.answer(command.accepted);
        return {};
      }
      case 'answer-model-picker': {
        if (!page.modelPicker || command.requestId !== page.modelPicker.value.requestId || !this.deps.answerModelPicker) return fail();
        return done(await this.deps.answerModelPicker(page.id, command.requestId, command.route));
      }
      case 'answer-directory':
        await this.answerDirectory(page, command);
        return done({});
      case 'authorization-result': {
        const authorization = page.authorizations?.get(command.requestId);
        if (!authorization?.result) return fail();
        const result = authorization.result;
        page.authorizations!.delete(command.requestId);
        return result;
      }
      case 'authorize': {
        const match = /^\/oauth\/([a-zA-Z0-9_-]+)\/connect$/.exec(command.path);
        if (
          !match ||
          !ghost.manifest.network?.secrets?.some((s) => s.key === match[1] && s.source === 'oauth')
        )
          return fail();
        page.authorizations ??= new Map();
        if (page.authorizations.size >= 4) return fail();
        const id = randomUUID();
        page.authorizations.set(id, { path: command.path, body: command.body, running: false });
        return { requestId: id, actionId: 'settings-oauth', expectedRevision: 0 };
      }
      case 'fetch': {
        if (!command.path.startsWith('/') || command.path.startsWith('//')) return fail();
        const url = new URL(command.path, 'https://plugin.invalid');
        if (
          url.origin !== 'https://plugin.invalid' ||
          url.hash ||
          !/^\/(?:kv|models|app-context|agent-models|media-models|secrets(?:\/[^/]+(?:\/check)?)?|oauth(?:\/[^/]+\/(?:client|default|insufficient-scopes|accounts\/[^/]+))?|connections(?:\/[^/]+(?:\/[^/]+)?)?|wake)$/.test(
            url.pathname,
          )
        )
          return fail();
        return done(
          await this.deps.settingsFetch!(
            ghost,
            url.pathname + url.search,
            command.method,
            command.body,
            () => current() && sourceId === (page.documentId ?? page.id),
            (label, host) =>
              this.confirm(sourceId, {
                ghostId: page.plugin,
                ghostName: ghost.manifest.name,
                iconDataUrl: ghost.iconDataUrl,
                body:
                  t('settings.ghosts.connections.confirmMessage')
                    .replaceAll('{{name}}', ghost.manifest.name)
                    .replaceAll('{{host}}', host) +
                  '\n\n' +
                  t('settings.ghosts.connections.confirmDetail').replaceAll('{{label}}', label),
                confirmText: t('settings.ghosts.connections.confirmAllow'),
                cancelText: t('settings.ghosts.connections.confirmCancel'),
                danger: false,
              }),
          ),
        );
      }
    }
  }
  private async answerDirectory(
    page: Page,
    input: { requestId?: unknown; path?: unknown },
  ): Promise<void> {
    if (
      typeof input.requestId !== 'string' ||
      !(
        input.path === null ||
        (typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096)
      )
    )
      return fail();
    const receipt = createHash('sha256').update(JSON.stringify(input.path)).digest('hex');
    const previous = page.directoryAnswers?.get(input.requestId);
    if (previous) {
      if (previous !== receipt) return fail();
      return;
    }
    const pending = page.directory;
    if (
      !pending ||
      pending.value.id !== input.requestId ||
      pending.answering ||
      pending.value.expiresAt <= this.now()
    )
      return fail();
    pending.answering = true;
    try {
      const path =
        input.path === null ? null : await this.deps.validateDirectory!(input.path as string);
      this.check(page);
      if (page.directory !== pending || pending.value.expiresAt <= this.now())
        return fail();
      clearTimeout(pending.timer);
      page.directory = undefined;
      page.directoryAnswers ??= new Map();
      page.directoryAnswers.set(input.requestId, receipt);
      if (page.directoryAnswers.size > 32)
        page.directoryAnswers.delete(page.directoryAnswers.keys().next().value!);
      pending.answer(path);
      return;
    } finally {
      pending.answering = false;
    }
  }
  private cancelDirectory(page: Page) {
    if (!page.directory) return;
    clearTimeout(page.directory.timer);
    page.directory.answer(null);
    page.directory = undefined;
  }
  captureSource(pageId: unknown, pluginId: string): () => boolean {
    if (typeof pageId !== 'string') return fail();
    const page = this.source(pageId);
    if (!page || page.plugin !== pluginId) return fail();
    this.check(page);
    return () => {
      try {
        this.page(page.id, page.controller);
        return this.source(pageId) === page;
      } catch {
        return false;
      }
    };
  }
  async chooseDirectory(
    pageId: string,
    pluginId: string,
    purpose: string | null,
  ): Promise<string | null> {
    const current = this.captureSource(pageId, pluginId),
      page = this.source(pageId)!;
    if (!current() || page.directory || !this.deps.validateDirectory) return fail();
    const ghost = this.check(page),
      id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancelDirectory(page), 90_000);
      page.directory = {
        timer,
        answer: resolve,
        answering: false,
        value: {
          id,
          pluginId,
          ghostName: ghost.manifest.name,
          purpose,
          expiresAt: this.now() + 90_000,
        },
      };
    });
  }
  notify(pageId: string, pluginId: string, text: string): boolean {
    this.sweep();
    const page = this.pages.get(pageId) ?? this.documentSources.get(pageId);
    if (!page || page.plugin !== pluginId || !page.currentOwner()) return false;
    try {
      this.check(page);
    } catch {
      return false;
    }
    page.notices.push({ id: randomUUID(), text });
    if (page.notices.length > 16) page.notices.shift();
    return true;
  }
  private sweep() {
    for (const page of this.pages.values()) {
      try {
        this.check(page);
        if (this.idleExpired(page)) this.close(page);
      } catch {
        if (this.pages.has(page.id)) this.close(page);
      }
    }
  }
  /** Explicit page context supplied by a plugin handling that page's business request.
   * A missing/invalid context never falls back to a different controller. */
  async confirm(pageId: string, params: GhostConfirmShowParams): Promise<boolean> {
    const page = this.source(pageId);
    if (!page || page.plugin !== params.ghostId) return fail();
    this.check(page);
    if (this.now() - page.touchedAt > 120_000 || page.confirms.size) return fail();
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        page.confirms.delete(id);
        resolve(false);
      }, 90_000);
      page.confirms.set(id, {
        timer,
        answer: resolve,
        value: {
          id,
          pluginId: params.ghostId,
          title: params.ghostName,
          body: params.body,
          confirmText: params.confirmText,
          cancelText: params.cancelText,
          danger: params.danger,
          expiresAt: this.now() + 90_000,
        },
      });
    });
  }
  modelPickerTarget(pageId: string, pluginId: string): PluginModelPickerTarget | null {
    const page = this.source(pageId);
    if (!page || page.plugin !== pluginId) return null;
    this.check(page);
    return {
      id: page.id,
      supportsRemoteRoutes: page.modelPickerRemoteSources === true,
      isCurrent: () => {
        try {
          this.check(page);
          return this.source(pageId) === page;
        } catch { return false; }
      },
      send: (value, cancel) => {
        this.check(page);
        if (this.source(pageId) !== page || page.modelPicker) return false;
        page.modelPicker = { value, cancel };
        return true;
      },
      dismiss: requestId => {
        if (page.modelPicker?.value.requestId === requestId) page.modelPicker = undefined;
      },
    };
  }
  private item(ghost: InstalledGhost): RemoteCollectionItem {
    const m = ghost.manifest;
    const id = installedGhostStoragePart(ghost);
    return {
      ref: { collectionId: PLUGIN_COLLECTION, kind: 'plugin', id },
      revision: this.deps.revision(ghost),
      display: {
        title: m.name,
        subtitle: m.description ?? '',
        ...(ghost.iconDataUrl
          ? {
              avatar: { kind: 'asset', value: ghost.iconDataUrl, fallbackText: m.name.slice(0, 1) },
            }
          : {}),
        // Desktop controllers read the enabled state from this label; toggling goes through management.
        status: { label: ghost.enabled ? 'enabled' : 'disabled', tone: 'neutral' },
      },
      links: [],
      actions: [],
    };
  }
  provider(): RemoteResourceProvider {
    return {
      collection: {
        id: PLUGIN_COLLECTION,
        resourceKind: 'plugin',
        title: { fallback: 'Plugins', translations: { 'zh-CN': '插件' } },
        icon: { name: 'puzzle', fallbackText: 'P' },
        ...(this.deps.management
          ? { actions: [
            { id: 'management:snapshot', label: 'Manage plugins' },
            { id: 'management:ui-consent', label: 'Read pending page consent' },
          ] }
          : {}),
      },
      list: async (_ctx, request) => {
        this.sweep();
        const q = request.query?.toLocaleLowerCase();
        const items = this.deps
          .list()
          .filter(
            (g) =>
              !q ||
              `${g.manifest.name} ${g.manifest.description ?? ''}`.toLocaleLowerCase().includes(q),
          )
          .map((g) => this.item(g));
        return {
          collectionId: PLUGIN_COLLECTION,
          revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
          items,
        };
      },
      get: async (_ctx, request) => {
        const ghost = this.ghost(request.ref.id);
        const item = this.item(ghost);
        const locale = resolvePreferredSystemLocale([request.client.locale ?? 'en']);
        // Read-only declaration facts and copy shared with the local plugin page; no saved values leave Host.
        const permissionText = (key: string, args?: Record<string, string>) =>
          t(`settings.ghosts.perm.${key}`, locale).replace(
            /\{\{(\w+)\}\}/g,
            (match, name: string) => args?.[name] ?? match,
          );
        const permissions = ghostPermissionItems(ghost.manifest)
          .filter((permission) => permission.kind !== 'tool')
          .map((permission) => ({
            kind: permission.kind,
            labelKey: permission.labelKey,
            title: permissionText(permission.labelKey, permission.labelArgs),
            description: [
              permission.detailKey
                ? permissionText(permission.detailKey, permission.detailArgs)
                : '',
              permission.detail ?? '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          }));
        const author = ghostFallbackDisplayAuthor(ghost);
        const detailFacts = [
          {
            key: 'version',
            title: t('settings.ghosts.detail.infoVersion', locale),
            value: 'v' + ghost.manifest.version,
          },
          ...(author
            ? [
                {
                  key: 'author',
                  title: t('settings.ghosts.detail.infoAuthor', locale),
                  value: author,
                },
              ]
            : []),
          {
            key: 'trust',
            title: t('settings.ghosts.detail.infoTrust', locale),
            value: t('settings.ghosts.trust.' + ghostTrustLabelKey(ghost.trust), locale).replaceAll(
              '{{publisher}}',
              ghost.trust?.publisherName ?? t('settings.ghosts.trust.unknownPublisher', locale),
            ),
          },
          {
            key: 'identifier',
            title: t('settings.ghosts.detail.infoId', locale),
            value: ghost.manifest.id,
          },
          {
            key: 'contents',
            title: t('settings.ghosts.detail.infoContents', locale),
            value: ghostContentKeys(ghost.manifest)
              .map((key) => t('settings.ghosts.contents.' + key, locale))
              .join(' · '),
          },
          {
            key: 'panel',
            title: t('settings.ghosts.detail.infoPanel', locale),
            value: t(
              ghost.manifest.panel
                ? 'settings.ghosts.contents.panel'
                : 'settings.ghosts.detail.panelNone',
              locale,
            ),
          },
          ...(ghost.dir
            ? [
                {
                  key: 'location',
                  title: t('settings.ghosts.detail.infoLocation', locale),
                  value: ghost.dir,
                },
              ]
            : []),
        ];
        return {
          ...item,
          blocks: [
            {
              id: 'about',
              primitive: 'markdown',
              fallbackMarkdown: ghost.manifest.description ?? '',
            },
            { id: 'version', primitive: 'status', fallbackMarkdown: ghost.manifest.version },
            {
              id: 'capabilities',
              primitive: 'plugin-capabilities',
              fallbackMarkdown: '',
              data: {
                tools:
                  ghost.manifest.tools?.map((tool) => ({
                    name: tool.name,
                    description: tool.description ?? '',
                  })) ?? [],
                permissions,
                details: detailFacts,
              },
            },
          ],
        };
      },
      invoke: async (context, request) => {
        this.sweep();
        if (request.actionId.startsWith('management:')) {
          if (!this.deps.management)
            throw new RemoteResourceRegistryError(
              'UNSUPPORTED_CAPABILITY',
              'Update Cindy on the target computer',
            );
          return this.deps.management.invoke(context.controllerDeviceId, request);
        }
        const input = record(request.input);
        const id = request.resourceRef?.id;
        if (!id || request.actionId !== 'settings:open') return fail();
        const ghost = this.ghost(id);
        if (
          !this.deps.settingsFetch ||
          !ghost.enabled ||
          !ghost.manifest.settingsHtml ||
          input.expectedInstalledApproval !== ghostInstallApprovalToken(ghost.approval) ||
          this.pages.size >= 32
        )
          return fail();
        const page: Page = {
          id: randomUUID(),
          plugin: id,
          controller: context.controllerDeviceId,
          modelPickerRemoteSources: input.modelPickerRemoteSources === true,
          revision: this.deps.revision(ghost),
          currentOwner: this.deps.captureOwner(),
          currentController: this.deps.captureController(context.controllerDeviceId),
          desktopSettings: true,
          touchedAt: this.now(),
          files: [],
          confirms: new Map(),
          notices: [],
        };
        this.check(page);
        page.files = await this.deps.bundle(ghost, ghost.manifest.settingsHtml);
        this.check(page);
        if (this.pages.size >= 32) return fail();
        this.pages.set(page.id, page);
        return {
          effects: [],
          result: {
            pageId: page.id,
            pluginId: id,
            manifestId: ghost.manifest.id,
            name: ghost.manifest.name,
            controllerAuthorization: true,
            documentIsolation: true,
            entry: ghost.manifest.settingsHtml,
            files: page.files,
          },
        };
      },
    };
  }
}
