#!/usr/bin/env node
// extract.mjs — 注销提示气泡(修复后)QA demo 真值提取器。机械提取,不手抄:
//  - desktop:LoginPage.tsx 气泡 class 串/结构事实/渲染位置(根层浮层、LoginStage 之外)、
//    colors.ts registerColor 值(login-deletion-bubble-bg 的 var 链解析:chat-input-bg/surface
//    /chat-input-border/login-control-text/login-secondary-text)、SUPPORTED_LOCALES 对应的
//    common.json 注销文案。
// stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '..', '..', '..');
const R = (p) => resolve(repoRoot, p);
const rel = (p) => `../../../${p}`;

function readSupportedLocales(srcRelRepo) {
  const source = readFileSync(R(srcRelRepo), 'utf8');
  const declaration = source.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/s)?.[1];
  const locales = declaration
    ? [...declaration.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
    : [];
  if (!locales.length) throw new Error(`${srcRelRepo} 未找到 SUPPORTED_LOCALES`);
  return locales;
}

const DESKTOP_LOCALES_TS = 'apps/desktop/src/shared/locale.ts';
const SUPPORTED_LOCALES = readSupportedLocales(DESKTOP_LOCALES_TS);

const hashes = new Map();
function fileHash(absPath) {
  if (!hashes.has(absPath)) {
    hashes.set(absPath, createHash('sha256').update(readFileSync(absPath)).digest('hex'));
  }
  return hashes.get(absPath);
}
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: { source: rel(srcRelRepo), locator, hash: `sha256:${fileHash(R(srcRelRepo))}` },
  };
}
function readSrc(p) {
  return readFileSync(R(p), 'utf8');
}
function leafFields(obj, srcRelRepo, prefix, locators = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = leaf(v, srcRelRepo, locators[k] ?? `${prefix}.${k}`);
  return out;
}
function extractConstObject(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`未找到 export const ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} 对象体未闭合`);
}
function numField(objSrc, key) {
  const m = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(objSrc);
  if (!m) throw new Error(`字段 ${key} 未命中`);
  return Number(m[1]);
}
function extractRegisterColor(src, name) {
  const re = new RegExp(`registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)'`, 's');
  const m = re.exec(src);
  if (!m && src.includes(`registerColor('${name}', GENERATED_DEFAULTS["${name}"]`)) {
    const generated = src.match(/const GENERATED_DEFAULTS = (\{[\s\S]*?\n\}) as const;/)?.[1];
    const pair = generated ? JSON.parse(generated)[name] : undefined;
    if (typeof pair?.light === 'string' && typeof pair?.dark === 'string') return pair;
  }
  if (!m) throw new Error(`registerColor('${name}') 未命中`);
  return { light: m[1], dark: m[2] };
}

/* ══ desktop ══ */
const P = {
  loginPage: 'apps/desktop/src/renderer/components/login/LoginPage.tsx',
  designTokens: 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts',
  loginScale: 'apps/desktop/src/renderer/components/login/loginScale.ts',
  colors: 'apps/desktop/src/renderer/themes/colors.ts',
  commonJson: (loc) => `apps/desktop/src/renderer/i18n/locales/${loc}/common.json`,
};
const loginPageSrc = readSrc(P.loginPage);
const colorsSrc = readSrc(P.colors);

// 结构事实:定位/缩放 wrapper(设计单位 × PANEL_FIXED_SCALE)+ 气泡本体 class
const bubbleWrapM = /data-testid="login-deletion-bubble-scale"\s*\n\s*className="(absolute left-1\/2 z-30)"/.exec(loginPageSrc);
if (!bubbleWrapM) throw new Error('desktop 气泡缩放 wrapper(data-testid + className)未命中(源码已变?)');
const bubbleClassM = /className="(w-full break-words border border-\[var\(--login-deletion-bubble-border\)\] bg-\[var\(--login-deletion-bubble-bg\)\] text-center)"/.exec(loginPageSrc);
if (!bubbleClassM) throw new Error('desktop 气泡 section className 未命中(源码已变?)');
// wrapper 的定位/缩放全部由 LOGIN_DELETION_BUBBLE × PANEL_FIXED_SCALE 计算,断言表达式在位
for (const expr of [
  'top: B.top * PANEL_FIXED_SCALE',
  'transform: `translateX(-50%) scale(${PANEL_FIXED_SCALE})`',
  "transformOrigin: 'top center'",
]) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop 气泡 wrapper 缺表达式:${expr}`);
}
// 内部几何消费设计常量(不再是 CSS px 字面量 class)
for (const expr of ['borderRadius: B.radius', 'padding: B.padding', 'fontSize: B.font', 'marginTop: B.titleBodyGap']) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop 气泡内部几何缺表达式:${expr}`);
}
const deskTokensSrc = readSrc(P.designTokens);
const deskScaleSrc = readSrc(P.loginScale);
const deskBubbleObj = extractConstObject(deskTokensSrc, 'LOGIN_DELETION_BUBBLE');
const panelFixedScale = Number(/PANEL_FIXED_SCALE\s*=\s*([\d.]+)/.exec(deskScaleSrc)[1]);
if (!(panelFixedScale > 0 && panelFixedScale <= 1)) throw new Error('PANEL_FIXED_SCALE 提取异常');
// 渲染位置结构事实:气泡在 </LoginStage> 之后(根层,不在 stage 文档流)
const renderPosM = /<\/LoginStage>\s*<CredentialStoreHelpDialog\b[^]*?\/>(\s*\{\/\* 注销状态提示气泡[^]*?<AccountDeletionStatusPanel)/.exec(loginPageSrc);
if (!renderPosM) throw new Error('desktop 气泡根层渲染位置(</LoginStage> 之后)未命中');
// completed 才传 onDismiss(结构事实,沿用旧逻辑未改动)
const dismissGateM = /accountDeletionStatus\.status === 'completed'\s*\?\s*\(\) =>/.exec(loginPageSrc);
if (!dismissGateM) throw new Error('desktop dismiss 仅 completed 结构未命中');
// 「我知道了」热区:上下 linkHitPadding 撑开 + 等量负 margin 抵消(设计单位,随 wrapper 缩放)
for (const expr of [
  'marginTop: B.bodyLinkGap - B.linkHitPadding',
  'marginBottom: -B.linkHitPadding',
  'paddingTop: B.linkHitPadding',
]) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop dismiss 热区缺表达式:${expr}`);
}

// 颜色 token:固定值(login skin 不随扩展主题,Fix A——弃用 var 链 alias)
const bubbleBg = extractRegisterColor(colorsSrc, 'login-deletion-bubble-bg');
const bubbleBorder = extractRegisterColor(colorsSrc, 'login-deletion-bubble-border');
if (bubbleBg.light.startsWith('var(') || bubbleBg.dark.startsWith('var('))
  throw new Error('login-deletion-bubble-bg 应为固定值(Fix A:login skin 不随扩展主题,禁 alias)');
if (bubbleBorder.light.startsWith('var(') || bubbleBorder.dark.startsWith('var('))
  throw new Error('login-deletion-bubble-border 应为固定值(Fix A 新增 token,禁 alias)');
const controlText = extractRegisterColor(colorsSrc, 'login-control-text');
const secondaryText = extractRegisterColor(colorsSrc, 'login-secondary-text');

const deskCopy = {};
for (const loc of SUPPORTED_LOCALES) {
  const j = JSON.parse(readSrc(P.commonJson(loc)));
  const st = j.accountDeletion?.status;
  if (!st) throw new Error(`${loc} common.json 缺 accountDeletion.status`);
  deskCopy[loc] = {
    pendingTitle: st.pendingTitle,
    pendingCopy: st.pendingCopy,
    processingTitle: st.processingTitle,
    processingCopy: st.processingCopy,
    completedTitle: st.completedTitle,
    completedCopy: st.completedCopy,
    dismissButton: st.dismissButton,
  };
}

/* ══ truth 组装 ══ */
const truth = {
  supportedLocales: SUPPORTED_LOCALES.map((locale, index) =>
    leaf(locale, DESKTOP_LOCALES_TS, `SUPPORTED_LOCALES[${index}]`),
  ),
  structure: {
    desktop: {
      renderPosition: leaf('LoginPage 根层(</LoginStage> 之后),不在 stage 文档流;absolute z-30 浮层', P.loginPage, 'LoginPage.tsx </LoginStage> 之后的 AccountDeletionStatusPanel 渲染点'),
      dismissGate: leaf("仅 completed 态传入 onDismiss(「我知道了」);pending/processing 无按钮", P.loginPage, "LoginPage.tsx accountDeletionStatus.status === 'completed' ? onDismiss : undefined"),
      bubbleClass: leaf(bubbleClassM[1], P.loginPage, 'AccountDeletionStatusPanel section className 全串'),
      wrapperClass: leaf(bubbleWrapM[1], P.loginPage, 'wrapper(定位+缩放层)className,几何走 inline style'),
      scaleContract: leaf(
        `几何为设计单位,wrapper 施加 translateX(-50%) scale(${panelFixedScale}) + transformOrigin top center;渲染值 = 设计单位 × ${panelFixedScale}(宽 ${numField(deskBubbleObj, 'width') * panelFixedScale} / 顶距 ${numField(deskBubbleObj, 'top') * panelFixedScale} CSS px)`,
        P.loginPage,
        'wrapper style: top/width/transform/transformOrigin',
      ),
      dismissHitArea: leaf(
        `上下各 ${numField(deskBubbleObj, 'linkHitPadding')} 设计单位 padding 撑热区 + 等量负 margin 抵消(视觉间距仍 上 ${numField(deskBubbleObj, 'bodyLinkGap')} / 下 ${numField(deskBubbleObj, 'padding')});缩放后约 ${(numField(deskBubbleObj, 'lineHeight') + 2 * numField(deskBubbleObj, 'linkHitPadding')) * panelFixedScale} CSS px 高(桌面鼠标指针)`,
        P.loginPage,
        'dismiss inline style marginTop/marginBottom/paddingTop/paddingBottom',
      ),
    },
  },
  desktop: {
    geometry: leafFields(
      {
        // 设计单位(1819×2098 的 2x 稿);渲染值 = 设计单位 × scale
        scale: panelFixedScale,
        top: numField(deskBubbleObj, 'top'),
        width: numField(deskBubbleObj, 'width'),
        radius: numField(deskBubbleObj, 'radius'),
        padding: numField(deskBubbleObj, 'padding'),
        fontSize: numField(deskBubbleObj, 'font'),
        lineHeight: numField(deskBubbleObj, 'lineHeight'),
        titleBodyGap: numField(deskBubbleObj, 'titleBodyGap'),
        bodyLinkGap: numField(deskBubbleObj, 'bodyLinkGap'),
        linkHitPadding: numField(deskBubbleObj, 'linkHitPadding'),
        borderWidth: 1,
        fontWeight: 400,
        zIndex: 30,
      },
      P.designTokens,
      'LOGIN_DELETION_BUBBLE(设计单位)',
      {
        scale: `loginScale.ts PANEL_FIXED_SCALE=${panelFixedScale}(面板恒定缩放,气泡同乘)`,
        borderWidth: 'LoginPage.tsx section style borderWidth=1/PANEL_FIXED_SCALE 设计单位(缩放补偿,渲染恰 1 物理 px;DESIGN.md §16.4)',
        fontWeight: 'LoginPage.tsx font-normal=400',
        zIndex: 'LoginPage.tsx wrapper z-30',
      },
    ),
    colors: {
      bubbleBg: {
        light: leaf(bubbleBg.light, P.colors, "registerColor('login-deletion-bubble-bg').light(固定值,Fix A 弃 alias)"),
        dark: leaf(bubbleBg.dark, P.colors, "registerColor('login-deletion-bubble-bg').dark(固定值)"),
      },
      bubbleBorder: {
        light: leaf(bubbleBorder.light, P.colors, "registerColor('login-deletion-bubble-border').light(Fix A 新增 token)"),
        dark: leaf(bubbleBorder.dark, P.colors, "registerColor('login-deletion-bubble-border').dark"),
      },
      titleText: {
        light: leaf(controlText.light, P.colors, "registerColor('login-control-text').light"),
        dark: leaf(controlText.dark, P.colors, "registerColor('login-control-text').dark"),
      },
      copyText: {
        light: leaf(secondaryText.light, P.colors, "registerColor('login-secondary-text').light"),
        dark: leaf(secondaryText.dark, P.colors, "registerColor('login-secondary-text').dark"),
      },
      bgBase: {
        light: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').light, P.colors, "registerColor('login-bg-base').light"),
        dark: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').dark, P.colors, "registerColor('login-bg-base').dark"),
      },
    },
    copy: Object.fromEntries(
      SUPPORTED_LOCALES.map((loc) => [
        loc,
        leafFields(deskCopy[loc], P.commonJson(loc), `accountDeletion.status(${loc})`),
      ]),
    ),
  },
};

process.stdout.write(JSON.stringify(truth, null, 1) + '\n');
