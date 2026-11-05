# @cindy/design-tokens

Desktop 已接管设计数值的 DTCG 编辑源。Terrazzo **2.7.1** 在构建期校验并生成；产品运行时只读取生成的本地子集，**不 import 此包或生成器**。

## 修改与生成

1. 在 `src/reference/` 修改标准 DTCG 值，或在 `src/semantic/`、`src/component/`、`src/themes/` 调整已批准的角色关系。`desktop-bindings.json` 只登记输出映射、保留项和文档用途，不存第二份数值。
2. 运行 `pnpm --filter @cindy/design-tokens generate`。同一 Terrazzo parse/build 流程生成全部输出及 DESIGN §3/§10、`login-flow.md` §16.1 已接管的精确摘要；品牌保护项单独保留，不读取测试 fixture。
3. 运行 `pnpm --filter @cindy/design-tokens generate -- --check`（或包脚本 `check:generated`）、本包测试、Desktop 冻结/主题/字号测试与适用门禁。生成两次必须稳定；缺文件、手改或过期输出失败。
4. 本次迁移不改冻结预期。有意改风格仍须按治理合同交真实证据与设计批准，批准后显式更新独立预期；不能通过重跑生成器自动刷新 fixture。

`src/{build-layers,snapshot,dtcg}.ts` 保留 DS-3 历史导入/测试 oracle；不在生产生成器依赖图中。`classification.json` 是冻结基线的历史分类，不再把其中“候选/未建模”误读为当前接管状态；当前逐项范围以 `desktop-bindings.json` 为准。

生成保护已由本包 `production.test.ts` 纳入 required unit workspace，在 Linux/Windows 单测分片执行；未单列快速 CI 步骤不表示没有保护。只需快速定位过期产物时运行 `pnpm --filter @cindy/design-tokens check:generated`。合法改值仍要按上面的生成、独立预期与设计裁决路径，不直接编辑产物。

间距尺度的事实源是 `src/desktop-bindings.json` 的 foundations.spacing 与 foundations.css 映射；例如 `p-4` 消费 `--space-4`。审计也从同一绑定读取，不维护第二份变量白名单；合法源引用不代替具体组件用途判断。

## 源与消费者

| 唯一编辑源 | 生成输出 | 实际消费者 |
| --- | --- | --- |
| reference/color + semantic/color + component/color | `themes/colors.ts` 的 GENERATED defaults 区 | 原注册 API/顺序/描述，主题解析，Button/Input、Diff、图表等全部旧 ID 消费者；同源生成额度条 CSS 首帧别名，不留手写副本 |
| reference/themes + themes/builtin | 11 个 `builtin/*.ts` 的 GENERATED theme 区 | 原主题身份、声明模式与加载 API；logo 等资源仍在适配层 |
| reference/shared + semantic/shared | `shared/windowBackdrop.ts` 的 GENERATED 区 | 主题与窗口共用的 CINDY 背板，原模块依赖不变 |
| reference/foundations + semantic/foundations | `styles/generated/tokens.css`、`token-mappings.ts`、`tailwind.config.ts` GENERATED 区 | globals 实际导入；通用字号/行高/字体/字重、spacing 尺度、圆角、标准 Input 尺寸、motion 与默认 transition |
| 同上默认字号 | `shared/generated/appearance-tokens.ts` | main/preload/renderer 共用 appearanceSettings；不改偏好限值、归一化与存储 |

构建专用 Tailwind 映射原位生成到配置文件，运行期只输出缩放/合并所需映射。旧 xl..5xl 配置保留缩放能力，源码仍禁止新增这些字号类；没有扩大排版或 DS-7 颜色豁免。

Effort/price 静态表也由 colors.ts 生成并导出，`effortTierColors.ts` import/re-export 并保留原插值、钳制、未知档回退。依赖变为单向 effort→colors→registry；独立导入会初始化无 DOM 的 registry，模块缓存保证重复导入不重注册。low/minimal/t1、max/ultra 及各档 Light/Dark 通过同一 reference 取值。

## 兼容与类型

- 标准类型：color、dimension（px/rem）、number、duration、cubicBezier、fontFamily、fontWeight、shadow。null 在模式绑定中显式保留，dark:null 继续走原 light 回退。
- 数值层单向：component→semantic→reference；内置主题覆盖只引用 reference/semantic。遗留 CSS alias 的直接目标及 var/hsl 包装由扩展元数据保留；Terrazzo 的终值用于校验，输出继续是符号引用。守卫核验符号目标与 DTCG 目标连接，不能把它们全部固化成 hex。
- `com.cindy.desktop` 格式元数据只记录大小写、精度、透明度/阴影语法，不存第二份值；`com.cindy.governance` 保留保护与语义豁免标签。保护标签限制改值，不放宽主题导入或颜色门禁。
- **历史 HSL 不按名称纠正**：Light text-primary 是 #262626，其 HSL 是 `0 0% 9%`；Dark surface-hover 是 #3c3c3a，其 HSL 是 `60 2% 17%`。它们不是精确同色。本批保留全部实际 triplet/alpha/小数格式；新导入仍遵守 DESIGN §10 的精确换算，CINDY twin/格式冻结照旧。
- 用户 `colors.radius`、局部/全局覆盖、未知 ID、导入、重复加载、磁盘字节与原主题顺序均保留。生成不读写用户主题目录。

## 已接管与保留

基线为 **541 ID / 11 内置主题**。DS-11 新增独立 `form-field-hint` 角色（默认保留 secondary-mid alias，One Dark Pro / Solarized 单独补可读性），Switch 新增独立 `switch-thumb-on` 角色（默认保留 background alias，CINDY Dark 使用近白滑块），Slider 与 Segmented 的独立组件角色已接管，当前 536 注册项接管，19 项原位保留：7 个 Markdown `inherit`、2 个登录背景 `none`、7 个 color-mix 运行期表达式，以及 annotation-accent / login-brand-accent / login-brand-accent-pressed 三个 register-only 保护 singleton。静态阴影、透明度、radius 和 splash 动效已建模，不能统称动态值漏掉。

动态模型 OKLCH 配色、effort 插值、字体选择/缩放/compact、reduced-motion、Diff 测量/Worker/缓存、数据几何及业务计时继续留在原代码。通用 Tailwind 尺度已接源，不代表所有局部任意值、第三方编辑器/终端/登录画布几何或各业务组件已完成设计迁移；这些保持现有登记与后续批次边界，不新增标准档位。

## 验证、回退与交接

生产测试在没有 fixture 的临时仓副本生成两次，逐输出注入缺失/手改/过期反例，并验证真实源改值进入输出。Desktop 独立冻结继续从实际 registry/builtin 提取；主题兼容、字号、模块加载与运行矩阵分别验证，不把静态测试称作实机通过。

SC-01—12、实机证据、未测平台和人工审核状态持续登记在桌面唯一主计划；截图不入 Git。DS-8 已合并 [#4268](https://github.com/makecindy/cindy/pull/4268)（merge `2e74488d21`）；DS-7 已合并 [#4215](https://github.com/makecindy/cindy/pull/4215)，合并提交 `4f03ea9a7b5f6425e517acd91071df6d397c6079`。旧 DS-6/7 附件不能充当本版本证据。

回退须整体恢复 DS-8 源/生成物/消费者及过渡守卫，保留上游工作；不回写用户数据或只抽掉生成源。G1 仅完成 Desktop 阶段；DS-9 已合并 #4300，桌面最终演练与交接由 DS-10 收尾。原影子层 2026-11-01 复查改为检查实际维护与消费情况，不取消维护责任。
