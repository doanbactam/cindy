# Cindy 客户端仓：Agent 工作入口

Cindy 是面向大众用户的开源 AI 助手，连接模型、工具与设备，帮助用户在自己的文件和
应用中完成工作。

## 仓库边界与安全底线

- 本仓库只负责 desktop 及其共享 packages。
- 服务端位于独立仓库；除非用户明确要求，不要跨仓修改服务端。
- 开始工作前先检查工作区状态，不覆盖、不回退用户已有改动。
- 先读实际代码和测试，再决定实现；不要只依赖文档猜测现状。
- 用户凭证、令牌、授权文件和密钥不得写入仓库或任何可能被 Git 跟踪的路径。
- 未经用户明确授权，不执行删除数据、覆盖改动、推送、发布、合并等外部或难以
  恢复的操作。
- 任务会触及系统提示词、更新器、协议兼容、数据库历史 migration、权限边界
  或用户数据安全时，先停下来核对专项规则，并在动手前向用户说明风险或请求确认。

## 产品方向

Cindy 面向大众用户：用户面前的简单，由产品在背后承担复杂。产品、UI 与架构的取舍以
[产品原则](docs/product-rules/core-product-principles.md)、[设计规范](docs/design-rules/DESIGN.md)
与[架构原则](docs/dev-rules/architecture-invariants.md)为准。

## 按模块进入

- 模块内规则在子目录的 AGENTS.md：[Desktop](apps/desktop/AGENTS.md)（开发正本
  [Desktop 开发](docs/dev-rules/desktop-development.md)）、[maker-core](packages/maker-core/AGENTS.md)
  （正本 [Agent 行为](docs/dev-rules/maker-core-and-agent-behavior.md)）；根级规则始终适用。
- 跨模块行为先从[仓库地图的行为导航](docs/dev-rules/repo-map.md#按用户行为定位)查找公共入口与测试，
  不要只修改最先找到的页面或渠道。

## 当前规则索引

修改前按改动主题在专题索引里找到正文再动手；涉及多个主题时同时适用：
[产品规则](docs/product-rules/README.md)、[设计规则](docs/design-rules/README.md)、
[开发规则](docs/dev-rules/README.md)。首次接触本仓或判断新代码归属时先读
[仓库地图](docs/dev-rules/repo-map.md)；首次安装、修复依赖或准备新 worktree 时先读
[环境准备](docs/dev-rules/environment-setup.md)；只为检查界面启动 Desktop 时用 `--mock`
免登录模拟数据（见 [UI 模拟数据](docs/dev-rules/ui-mock-data.md)）。

下列规则跨模块且不得回退，细则只在链接的正文维护：

- Pi 原生能力非退化：同版本原生 Pi 能完成的安装、更新、扩展加载与 Agent 自助修复，Cindy
  不得以任何新增检查或审批让它失败、停用或更难用；见
  [Pi harness](docs/dev-rules/pi-harness.md)「Pi 上游 GUI 非退化红线」。
- 存量插件兼容：用户升级后什么都不做，已装、已批准、已启用的插件照旧可用；改到插件基座的
  PR 走白名单确认门；见[插件安全与编写](docs/dev-rules/plugin-security-and-authoring.md)第 5 节。
- 日志上报：记录边界、白名单方向、标记代次 + 原子清除三条不变量不得破坏，脱敏规则只增不减；
  见[日志上报与脱敏](docs/dev-rules/log-upload-and-redaction.md)。
- 代输入：主人填写的值只交给宿主执行，不进模型、记录、日志、IM 与推送；见
  [代输入](docs/product-rules/input-handoff.md)。
- 测试：新增或改写测试前读[工程约定](docs/dev-rules/engineering-conventions.md) §3.2 的价值门槛
  与性能预算。
- 界面：所有新增或修改的 UI 同时实现 Light 与 Dark（颜色走语义 token）；未目检的模式如实
  写明；见 [DESIGN.md](docs/design-rules/DESIGN.md)「双模式交付门槛」。

## Git 与交付

尊重用户与宿主提供的工作流，已有任务分支或 worktree 直接复用，不嵌套创建，
不擅自搬动或混用工作区。本仓默认 PR-first；只有仓库维护者明确选择例外时才允许
直推主干。仓库规则本身不额外授权 commit、push、发布或合并。

每个 commit 用 `git commit -s` 带 DCO 签名，细则见[开发工作流](docs/dev-rules/development-workflow.md)。
提交 PR 遵循 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)；
自动审阅是建议性检查，修改 [REVIEW.md](REVIEW.md) 或自动审阅 workflow 前先读其说明。

提交前完成与风险匹配的测试和相关 package 类型检查，默认使用 `pnpm test:unit:related`；
已完成等效定向验证时不要求重跑整仓，纯文档运行 `pnpm check:dev-docs`。完成后 review
整体 diff。失败、既有故障、未验证项和需要用户决定的事项须如实报告，不得通过跳过、删除
或弱化测试制造通过。本机资源预算、并发与跨任务排队由用户或宿主决定，完整检查与合并门禁
仍由 CI 保障。DCO 核验、按风险追加验证及直推门禁见[开发工作流](docs/dev-rules/development-workflow.md)。

可复用的项目知识写进仓库；个人路径、设备标识、账号偏好、凭据和私聊原文留在本地。
整理文档只改组织与索引，Cindy 特有的信息不得丢失或弱化；细则见
[开发工作流](docs/dev-rules/development-workflow.md) §4、§5。
