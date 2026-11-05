#!/usr/bin/env node
// extract.mjs — cindy 登录链路 QA demo 真值提取器(桌面端 desk;移动端 App 下线后 phone / pad 部分已移除)。
// 机械提取,不手抄:
//  - desk:布局常量/缩放公式经 esbuild 编译产品 TS 后 import;颜色 token 正则解析
//    themes/colors.ts;文案 JSON.parse 五语 common.json;协议链接/窗口最小尺寸/内联
//    SVG path 正则定位;adaptive.samples 用产品 loginScale.ts 真公式预计算(= 桌面基线
//    docs/design-previews/login-flow-hifi/extract.mjs 同构,truth 命名空间迁入 desk.*)。
//  - 品牌位图:产品 PNG 逐字节拷贝进 demo assets/(byte-identical),truth 记录
//    sha256 + IHDR 尺寸;asset-sha 门 D 绑定按 sha 比对。
// stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
// demo 位于 <repo>/docs/design-previews/<name>/ → 上三级即仓库根(同 login-flow-hifi)。
// 加一条根校验:demo 目录若被移动,这里立刻报清楚,而不是等到 compileModules 里 ENOENT。
const repoRoot = resolve(demoDir, '..', '..', '..');
if (!existsSync(resolve(repoRoot, 'pnpm-workspace.yaml')))
  throw new Error(`推导出的仓库根不是本仓(缺 pnpm-workspace.yaml):${repoRoot}\n` +
    `本提取器假定 demo 位于 <repo>/docs/design-previews/<name>/;若已移动目录,请同步改 repoRoot 的层数。`);
const R = (p) => resolve(repoRoot, p); // 绝对路径
import { relative } from 'node:path';
// provenance 的 source 写成「相对 demo 目录」的路径,由 repoRoot 反推,
// 不写死层数 —— 换目录时跟着 repoRoot 一起变,不会再出现存在性校验红。
const REL_PREFIX = relative(demoDir, repoRoot).split(sep).join('/');
const rel = (p) => `${REL_PREFIX}/${p}`;

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

/** 包一个 truth 叶子:value + provenance(source 相对 demoDir,hash=源文件 sha256)。 */
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: { source: rel(srcRelRepo), locator, hash: `sha256:${fileHash(R(srcRelRepo))}` },
  };
}

/** 把编译 import 得到的对象逐叶包 provenance(locator = export 路径前缀)。 */
function wrapObj(obj, srcRelRepo, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      v !== null && typeof v === 'object'
        ? wrapObj(v, srcRelRepo, `${prefix}.${k}`)
        : leaf(v, srcRelRepo, `${prefix}.${k}`);
  }
  return out;
}

/* ── esbuild 编译产品 TS → 临时 .mjs → import(与桌面基线同法) ── */
const require2 = createRequire(join(repoRoot, 'package.json'));
const esbuild = require2('esbuild');

/**
 * 编译一组 TS 文件并 import。transform 可选:对编译后 JS 做文本替换——
 * loginMessages.ts 依赖 expo-localization / @/i18n/appLanguage(RN 侧),
 * 提取只需要 messages/authErrorMessages 常量,用确定桩替换 import 行(不执行任何 RN 代码)。
 */
async function compileModules(entries) {
  const tmp = mkdtempSync(join(tmpdir(), 'login-all-hifi-extract-'));
  const mods = {};
  try {
    for (const [src, out, transform] of entries) {
      let code = esbuild.transformSync(readFileSync(R(src), 'utf8'), {
        loader: 'ts',
        format: 'esm',
      }).code;
      if (transform) code = transform(code);
      writeFileSync(join(tmp, out), code);
      mods[out] = await import(pathToFileURL(join(tmp, out)).href);
    }
    return mods;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 拷贝产品资产到 demo assets/ 并产出 { file, sha256, width?, height? } 叶子组。 */
const ASSET_DIR = join(demoDir, 'assets');
mkdirSync(ASSET_DIR, { recursive: true });
function pngDims(absPath) {
  const buf = readFileSync(absPath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`非 PNG:${absPath}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function assetLeaf(srcRelRepo, destName, { dims = true } = {}) {
  const abs = R(srcRelRepo);
  copyFileSync(abs, join(ASSET_DIR, destName));
  const out = {
    file: leaf(`assets/${destName}`, srcRelRepo, '产品资产逐字节拷贝(cp → demo assets/)'),
    sha256: leaf(fileHash(abs), srcRelRepo, '源文件 sha256(asset-sha 绑定期望值)'),
  };
  if (dims) {
    const { width, height } = pngDims(abs);
    out.width = leaf(width, srcRelRepo, 'PNG IHDR width');
    out.height = leaf(height, srcRelRepo, 'PNG IHDR height');
  }
  return out;
}

/* ════════════════════════ desk(桌面,= 基线提取器同构) ════════════════════════ */
let deskSamples; // 顶层 adaptive.samples 用(见文件尾)
const desk = await (async () => {
  const TOKENS_TS = 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts';
  const SCALE_TS = 'apps/desktop/src/renderer/components/login/loginScale.ts';
  const METHOD_TS = 'apps/desktop/src/shared/loginIdentifierMethod.ts';
  const mods = await compileModules([
    [TOKENS_TS, 'desk-tokens.mjs'],
    // loginScale.ts 自 2026-07-27 改版起 import LOGIN_GROUP(组高 620 单一来源):
    // 临时目录里文件名被扁平化,把相对 import 重定向到同批编译的 desk-tokens.mjs
    [
      SCALE_TS,
      'desk-scale.mjs',
      (code) => code.replace(/from\s*['"]\.\/loginDesignTokens['"]/g, "from './desk-tokens.mjs'"),
    ],
    [METHOD_TS, 'desk-method.mjs'],
  ]);
  const tokens = mods['desk-tokens.mjs'];
  const scaleMod = mods['desk-scale.mjs'];
  const methodMod = mods['desk-method.mjs'];

  const geometry = {
    stage: wrapObj({ width: scaleMod.LOGIN_STAGE_WIDTH, height: scaleMod.LOGIN_STAGE_HEIGHT }, SCALE_TS, 'LOGIN_STAGE_*'),
    hero: wrapObj(tokens.HERO, TOKENS_TS, 'HERO'),
    wordmark: wrapObj(tokens.WORDMARK, TOKENS_TS, 'WORDMARK'),
    slogan: wrapObj(tokens.SLOGAN, TOKENS_TS, 'SLOGAN'),
    loginGroup: wrapObj(tokens.LOGIN_GROUP, TOKENS_TS, 'LOGIN_GROUP'),
    localMode: wrapObj(tokens.LOGIN_LOCAL_MODE, TOKENS_TS, 'LOGIN_LOCAL_MODE'),
    panel: wrapObj(tokens.PANEL, TOKENS_TS, 'PANEL'),
    title: wrapObj(tokens.TITLE, TOKENS_TS, 'TITLE'),
    subtitle: wrapObj(tokens.SUBTITLE, TOKENS_TS, 'SUBTITLE'),
    /* 2026-07-XX #554:徽标翻转为「global 不标、cn/dev 才标」,宽度由 paddingX 撑开(无 width) */
    regionPill: wrapObj(tokens.REGION_PILL, TOKENS_TS, 'REGION_PILL'),
    control: wrapObj(tokens.CONTROL, TOKENS_TS, 'CONTROL'),
    spinner: wrapObj(tokens.SPINNER, TOKENS_TS, 'SPINNER'),
    social: wrapObj(tokens.SOCIAL, TOKENS_TS, 'SOCIAL'),
    back: wrapObj(tokens.BACK, TOKENS_TS, 'BACK'),
    errorText: wrapObj(tokens.ERROR_TEXT, TOKENS_TS, 'ERROR_TEXT'),
    /* 2026-07-27 登录改版:面板内「跳过登录」文字按钮槽(680×60 @y430,字号 24,热区左右各 30) */
    skipEntry: wrapObj(tokens.SKIP_ENTRY, TOKENS_TS, 'SKIP_ENTRY'),
    /* Splash 面板高 440:不跟随登录面板 500(SPLASH_PANEL 注释;demo 不渲染 splash,留证 */
    splashPanelHeight: leaf(tokens.SPLASH_PANEL.height, TOKENS_TS, 'SPLASH_PANEL.height'),
    methodRow: wrapObj(tokens.METHOD_ROW, TOKENS_TS, 'METHOD_ROW'),
    loadingRing: wrapObj(tokens.LOADING_RING, TOKENS_TS, 'LOADING_RING'),
    textLink: wrapObj(tokens.TEXT_LINK, TOKENS_TS, 'TEXT_LINK'),
    ssoOrgHint: wrapObj(tokens.SSO_ORG_HINT, TOKENS_TS, 'SSO_ORG_HINT'),
    consentRow: wrapObj(tokens.CONSENT_ROW, TOKENS_TS, 'CONSENT_ROW'),
    consentDialog: wrapObj(tokens.CONSENT_DIALOG, TOKENS_TS, 'CONSENT_DIALOG'),
    dragBarHeight: leaf(tokens.DRAG_BAR_HEIGHT, TOKENS_TS, 'DRAG_BAR_HEIGHT'),
  };

  /* 颜色 token:正则解析 registerColor('login-*', {light, dark}) */
  const COLORS_TS = 'apps/desktop/src/renderer/themes/colors.ts';
  const colorsSrc = readFileSync(R(COLORS_TS), 'utf8');
  // DS-8 将默认值抽到生成的 JSON 字面量；保留对旧内联声明的读取。
  const generatedDefaultsSource = colorsSrc.match(/const GENERATED_DEFAULTS = (\{[\s\S]*?\n\}) as const;/)?.[1];
  const generatedDefaults = generatedDefaultsSource ? JSON.parse(generatedDefaultsSource) : {};
  function tokenPair(name) {
    const re = new RegExp(
      `registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)',?\\s*\\}`,
    );
    const m = colorsSrc.match(re);
    const usesGenerated = colorsSrc.includes(`registerColor('${name}', GENERATED_DEFAULTS["${name}"]`);
    const pair = m ? { light: m[1], dark: m[2] } : usesGenerated ? generatedDefaults[name] : undefined;
    if (typeof pair?.light !== 'string' || typeof pair?.dark !== 'string') {
      throw new Error(`colors.ts 未找到 token ${name}`);
    }
    return {
      light: leaf(pair.light, COLORS_TS, `registerColor('${name}').light`),
      dark: leaf(pair.dark, COLORS_TS, `registerColor('${name}').dark`),
    };
  }
  const colorNames = {
    bgBase: 'login-bg-base',
    panelBg: 'login-panel-bg',
    panelBorder: 'login-panel-border',
    brandAccent: 'login-brand-accent',
    controlBg: 'login-control-bg',
    actionControlBg: 'login-action-control-bg',
    backBorder: 'login-back-border',
    controlBorder: 'login-control-border',
    controlBorderActive: 'login-control-border-active',
    controlBorderDisabled: 'login-control-border-disabled',
    controlText: 'login-control-text',
    controlPlaceholder: 'login-control-placeholder',
    titleText: 'login-title-text',
    secondaryText: 'login-secondary-text',
    primaryButtonBg: 'login-primary-button-bg',
    primaryButtonBorder: 'login-primary-button-border',
    primaryButtonText: 'login-primary-button-text',
    disabledButtonBg: 'login-disabled-button-bg',
    disabledButtonText: 'login-disabled-button-text',
    invertedButtonBorder: 'login-inverted-button-border',
    linkText: 'login-link-text',
    linkHover: 'login-link-hover',
    linkPressed: 'login-link-pressed',
    errorFg: 'login-error-fg',
    appleCircleBg: 'login-apple-circle-bg',
    consentRadioBg: 'login-consent-radio-bg',
    consentRadioBorder: 'login-consent-radio-border',
    consentRadioCheckedBg: 'login-consent-radio-checked-bg',
    consentRadioCheck: 'login-consent-radio-check',
    consentOverlay: 'login-consent-overlay',
    secondaryButtonBg: 'login-secondary-button-bg',
    secondaryButtonBorder: 'login-secondary-button-border',
    secondaryButtonText: 'login-secondary-button-text',
    loadingRingTrack: 'login-loading-ring-track',
    overlayButtonHover: 'login-overlay-button-hover',
    overlayButtonPressed: 'login-overlay-button-pressed',
    overlayBackHover: 'login-overlay-back-hover',
    overlayBackPressed: 'login-overlay-back-pressed',
    overlayRowHover: 'login-overlay-row-hover',
    overlayRowPressed: 'login-overlay-row-pressed',
    overlayInputHover: 'login-overlay-input-hover',
    overlaySecondaryHover: 'login-overlay-secondary-hover',
    overlaySecondaryPressed: 'login-overlay-secondary-pressed',
    // 通用主题色(非 login-* 族):账号注销状态横幅使用(LoginPage AccountDeletionStatusPanel)
    genericBorder: 'border-default',
    genericSurfaceChip: 'surface-chip',
    genericTextPrimary: 'text-primary',
    genericTextSecondary: 'text-secondary',
  };
  const colors = {};
  for (const [key, name] of Object.entries(colorNames)) colors[key] = tokenPair(name);

  /* 产品支持语言文案:JSON.parse common.json */
  const COPY_KEYS = [
    'title', 'subtitle', 'phonePlaceholder', 'emailPlaceholder', 'invalidEmail', 'invalidPhone',
    'working', 'continue', 'back', 'cancel', 'chooseMethod', 'orgDetected', 'enterpriseLogin',
    'enterpriseVia', 'personalLogin', 'personalDesc', 'ssoRequired', 'ssoEntry', 'localModeEntry',
    'localModeDescription', 'consentStatement',
    'consentDialog.title', 'consentDialog.body', 'consentDialog.agree', 'consentDialog.disagree',
    'ssoOrgTitle', 'ssoOrgSubtitle', 'ssoOrgPlaceholder', 'ssoOrgHint', 'ssoOrgDetected',
    'ssoVerificationTitle', 'ssoVerificationSubtitle', 'enterCode', 'codeSentTo', 'codePlaceholder',
    'verifying', 'signIn', 'resendCode', 'resendCountdown', 'chooseAccount', 'chooseAccountSubtitle',
    'personalAccount', 'binding.phoneTitle', 'binding.phoneSubtitle', 'binding.emailTitle',
    'binding.emailSubtitle', 'sendCode', 'completeSignIn', 'preparing', 'preparingSubtitle',
    'unavailable', 'retry', 'browserWaiting', 'regionPill.cn', 'regionPill.dev',
    'errors.fallback', 'errors.INVALID_CODE', 'errors.AUTH_SERVICE_UNAVAILABLE',
    'social.apple', 'social.google', 'social.wechat',
  ];
  const copy = {};
  for (const lang of SUPPORTED_LOCALES) {
    const src = `apps/desktop/src/renderer/i18n/locales/${lang}/common.json`;
    const json = JSON.parse(readFileSync(R(src), 'utf8'));
    const bag = {};
    for (const key of COPY_KEYS) {
      const val = key.split('.').reduce((o, k) => o?.[k], json.login);
      if (typeof val !== 'string') throw new Error(`${src} 缺 login.${key}`);
      bag[key] = leaf(val, src, `login.${key}`);
    }
    // 账号注销状态横幅文案(common.json 根部 accountDeletion.status.*,不在 login 下)
    const DEL_KEYS = ['pendingTitle', 'processingTitle', 'completedTitle', 'pendingCopy', 'processingCopy', 'completedCopy', 'dismissButton'];
    for (const key of DEL_KEYS) {
      const val = json.accountDeletion?.status?.[key];
      if (typeof val !== 'string') throw new Error(`${src} 缺 accountDeletion.status.${key}`);
      bag[`deletion.${key}`] = leaf(val, src, `accountDeletion.status.${key}`);
    }
    copy[lang] = bag;
  }

  /* 协议链接 */
  const LEGAL_TS = 'apps/desktop/src/shared/legalLinks.ts';
  const legalSrc = readFileSync(R(LEGAL_TS), 'utf8');
  function legalOf(constName, key) {
    const block = legalSrc.match(new RegExp(`const ${constName}[\\s\\S]*?\\};`))?.[0];
    const m = block?.match(new RegExp(`${key}:\\s*'([^']+)'`));
    if (!m) throw new Error(`legalLinks.ts 未找到 ${constName}.${key}`);
    return leaf(m[1], LEGAL_TS, `${constName}.${key}`);
  }
  const urls = {
    cn: { terms: legalOf('CN_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('CN_LEGAL_LINKS', 'privacyPolicy') },
    global: { terms: legalOf('GLOBAL_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('GLOBAL_LEGAL_LINKS', 'privacyPolicy') },
  };

  /* 常量:倒计时/面板恒定缩放/窗口最小尺寸/区域 identifier 形态 */
  const BOOT_TS = 'apps/desktop/src/main/bootstrap-electron.ts';
  const bootSrc = readFileSync(R(BOOT_TS), 'utf8');
  const minW = bootSrc.match(/minWidth:\s*(\d+)/);
  const minH = bootSrc.match(/minHeight:\s*(\d+)/);
  if (!minW || !minH) throw new Error('bootstrap-electron.ts 未找到主窗口 minWidth/minHeight');
  const bothProviders = { email: true, phone: true };
  const constants = {
    resendCountdownMs: leaf(tokens.RESEND_COUNTDOWN_MS, TOKENS_TS, 'RESEND_COUNTDOWN_MS'),
    panelFixedScale: leaf(scaleMod.PANEL_FIXED_SCALE, SCALE_TS, 'PANEL_FIXED_SCALE'),
    minWindow: {
      w: leaf(Number(minW[1]), BOOT_TS, 'mainWindow BrowserWindow minWidth'),
      h: leaf(Number(minH[1]), BOOT_TS, 'mainWindow BrowserWindow minHeight'),
    },
    identifierMethod: {
      cn: leaf(methodMod.resolveIdentifierMethod('cn', bothProviders), METHOD_TS, 'resolveIdentifierMethod(cn)'),
      global: leaf(methodMod.resolveIdentifierMethod('global', bothProviders), METHOD_TS, 'resolveIdentifierMethod(global)'),
    },
  };

  /* 图标:SVG 资产全文 + LoginControls 内联矢量 path */
  const ICON_DIR = 'apps/desktop/src/renderer/assets/login/icons';
  function svgAsset(name) {
    const src = `${ICON_DIR}/${name}.svg`;
    return leaf(readFileSync(R(src), 'utf8'), src, 'svg 文件全文');
  }
  const CONTROLS_TSX = 'apps/desktop/src/renderer/components/login/LoginControls.tsx';
  const controlsSrc = readFileSync(R(CONTROLS_TSX), 'utf8');
  function fnBlock(src, fnName) {
    const start = src.indexOf(`function ${fnName}`);
    if (start === -1) throw new Error(`${fnName} 未找到`);
    const next = src.indexOf('\nfunction ', start + 1);
    const nextExport = src.indexOf('\nexport ', start + 1);
    const ends = [next, nextExport].filter((i) => i !== -1);
    return src.slice(start, ends.length ? Math.min(...ends) : undefined);
  }
  function pathsOf(src, fnName, tsx) {
    const ds = [...fnBlock(src, fnName).matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    if (!ds.length) throw new Error(`${fnName} 内未找到 svg path`);
    return ds.map((d, i) => leaf(d, tsx, `function ${fnName} path[${i}].d`));
  }
  const backChevronD = (() => {
    const block = fnBlock(controlsSrc, 'LoginBackButton');
    const m = block.match(/d="([^"]+)"/);
    if (!m) throw new Error('LoginBackButton 内未找到 chevron path');
    return leaf(m[1], CONTROLS_TSX, 'LoginBackButton chevron path.d');
  })();
  const icons = {
    apple: { light: svgAsset('apple'), dark: svgAsset('apple-dark') },
    google: { light: svgAsset('google'), dark: svgAsset('google') },
    wechat: { light: svgAsset('wechat'), dark: svgAsset('wechat') },
    sso: { light: svgAsset('sso'), dark: svgAsset('sso-dark') },
    // guest 图标已随「跳过登录」文字入口取代游客圆钮删除(2026-07-27 改版;
    // guest.svg / guest-dark.svg 在本次改动里已从产品仓移除,故不再提取)
    paths: {
      backChevron: backChevronD,
      consentCheck: pathsOf(controlsSrc, 'ConsentCheckGlyph', CONTROLS_TSX)[0],
      person: pathsOf(controlsSrc, 'PersonIcon', CONTROLS_TSX),
      enterprise: pathsOf(controlsSrc, 'EnterpriseIcon', CONTROLS_TSX),
      share: pathsOf(controlsSrc, 'ShareIcon', CONTROLS_TSX),
      spinnerArc: pathsOf(controlsSrc, 'LoginSpinnerGlyph', CONTROLS_TSX)[0],
    },
  };

  /* 「跳过登录」热区语义(2026-07-27 改版):槽 pointerEvents:none = 680×60 布局容器死区,
     内层 button pointerEvents:auto = 真正可点区(文字宽 + 左右 hitPaddingX)。
     由 LoginSkipEntry 源码正则提取,并派生出 demo 侧可机械核对的命中判据(门 D kind:text)。 */
  const skipBlock = fnBlock(controlsSrc, 'LoginSkipEntry');
  const slotPe = skipBlock.match(/pointerEvents: '(none)'/)?.[1];
  const btnPe = skipBlock.match(/pointerEvents: '(auto)'/)?.[1];
  if (!slotPe || !btnPe)
    throw new Error("LoginSkipEntry 未找到 pointerEvents 分层(槽 'none' / 内层 button 'auto')");
  if (!/color: LOGIN_COLORS\.secondaryText/.test(skipBlock))
    throw new Error('LoginSkipEntry 未使用 LOGIN_COLORS.secondaryText 作文字色');
  constants.skipEntry = {
    slotPointerEvents: leaf(slotPe, CONTROLS_TSX, 'LoginSkipEntry 槽 style.pointerEvents'),
    buttonPointerEvents: leaf(btnPe, CONTROLS_TSX, 'LoginSkipEntry button style.pointerEvents'),
    colorToken: leaf('secondaryText', CONTROLS_TSX, 'LoginSkipEntry style.color = LOGIN_COLORS.secondaryText'),
    hitDeadZone: leaf(
      slotPe === 'none' ? 'not-button' : 'button',
      CONTROLS_TSX,
      "由槽 pointerEvents:'none' 派生的期望命中语义:680×60 容器死区点击不落跳过按钮",
    ),
    hitTextZone: leaf(
      btnPe === 'auto' ? 'button' : 'not-button',
      CONTROLS_TSX,
      "由 button pointerEvents:'auto' 派生的期望命中语义:文字 + 左右扩展区命中跳过按钮",
    ),
  };

  /* adaptive.samples:产品 loginScale 真公式预计算(oracle = 源码本身) */
  const SAMPLE_SIZES = [
    [800, 600], [800, 601], [900, 620], [1024, 640], [1280, 720],
    [1280, 800], [1280, 801], [1440, 900], [1680, 1050], [800, 1200],
  ];
  const r2 = (v) => Math.round(v * 100) / 100;
  const samples = SAMPLE_SIZES.map(([w, h]) => {
    const reserve = tokens.LOGIN_LOCAL_MODE.reservedHeight;
    const pp = scaleMod.panelPlacement(w, h, tokens.LOGIN_GROUP.yDefault, reserve);
    const bp = scaleMod.brandPlacement(w, h, reserve);
    const midX = scaleMod.LOGIN_STAGE_WIDTH / 2;
    const midY = scaleMod.LOGIN_STAGE_HEIGHT / 2;
    const bx = (designX) => w / 2 + (designX - midX) * bp.scale;
    const by = (designY) => h / 2 + (designY - midY) * bp.scale + bp.translateY;
    const shift = scaleMod.sloganShiftX(w, bp.scale);
    const panelW = tokens.LOGIN_GROUP.width * pp.scale;
    return {
      w, h,
      probes: {
        panel: {
          x: r2(pp.centerX - panelW / 2),
          y: r2(pp.topY),
          w: r2(panelW),
          h: r2(tokens.LOGIN_GROUP.height * pp.scale),
        },
        hero: {
          x: r2(bx(tokens.HERO.x)),
          y: r2(by(tokens.HERO.y)),
          w: r2(tokens.HERO.size * bp.scale),
          h: r2(tokens.HERO.size * bp.scale),
        },
        slogan: {
          x: r2(bx(tokens.SLOGAN.x + shift)),
          y: r2(by(tokens.SLOGAN.y)),
          w: r2(tokens.SLOGAN.width * bp.scale),
          h: r2(tokens.SLOGAN.height * bp.scale),
        },
      },
    };
  });
  deskSamples = samples;

  /* 品牌位图资产(逐字节拷贝;hero-mask.svg 是 alpha mask 资产) */
  const ASSETS = 'apps/desktop/src/renderer/assets/login';
  const assets = {
    hero: assetLeaf(`${ASSETS}/hero.png`, 'desk-hero.png'),
    heroMask: assetLeaf(`${ASSETS}/hero-mask.svg`, 'desk-hero-mask.svg', { dims: false }),
    sloganLight: assetLeaf(`${ASSETS}/slogan.png`, 'desk-slogan-light.png'),
    sloganDark: assetLeaf(`${ASSETS}/slogan-dark.png`, 'desk-slogan-dark.png'),
    wordmarkLight: assetLeaf(`${ASSETS}/wordmark.png`, 'desk-wordmark-light.png'),
    wordmarkDark: assetLeaf(`${ASSETS}/wordmark-dark.png`, 'desk-wordmark-dark.png'),
  };

  return { geometry, colors, copy, urls, constants, icons, assets };
})();

/* desk 的 adaptive.samples 单独挂到 truth 根(verify.mjs 门 F 硬编码读 adaptive.samples;
   provenance 豁免路径也是 adaptive.samples——故不放 desk.* 下)。 */
const supportedLocales = SUPPORTED_LOCALES.map((locale, index) =>
  leaf(locale, DESKTOP_LOCALES_TS, `SUPPORTED_LOCALES[${index}]`),
);
process.stdout.write(
  JSON.stringify({ desk, supportedLocales, adaptive: { samples: deskSamples } }, null, 2),
);
