# 任务体验回归入口

> 修改任务创建、发送、恢复、归档、权限或默认模型时，先从对应行找到现有测试。
> 代码位置和共用入口见[仓库地图](repo-map.md)，测试价值与分层遵循[工程约定](engineering-conventions.md#32-新增测试的价值门槛)。

这份索引保存已反复遇到的用户场景与验证入口，不另建状态机或测试运行器。修改共同入口时反查普通任务、伙伴、群、调度、本机和远程调用方；只检查本次行为影响的入口，保留产品明确要求的差异。

| 场景 | 要保住的行为 | 现有回归入口 |
| --- | --- | --- |
| 导入 Codex 历史后继续发送 | 导入时一次性把历史复制进 Cindy，之后只走实时写入，打开或翻页都不再重读原 rollout，同一回复只显示一份；旧版按需导入留下的任务首次打开时接入新导入记录，不重复写消息 | [messagesListImportSideEffects](../../apps/desktop/src/main/localDb/ipc/__tests__/messagesListImportSideEffects.test.ts) 的接入场景；[codexLocalSessions](../../apps/desktop/src/main/__tests__/codexLocalSessions.test.ts) 的分页 rollout 接管与续跑准备 |
| 本地插件或历史文件多时切换任务、输入 | 通知发现只合并在途扫描，投递前重新核验安装与账号；展示用目录偏好异步读取，旧目录结果不覆盖新目录；历史定位只 stat 匹配 ID 的文件；麦克风热路径不等待 main | [subscriptionGateway](../../apps/desktop/src/main/cindy-brain/__tests__/subscriptionGateway.test.ts)、[codexLocalSessions](../../apps/desktop/src/main/__tests__/codexLocalSessions.test.ts)、[useInstalledGhosts](../../apps/desktop/src/renderer/cindy-brain/__tests__/useInstalledGhosts.test.tsx)、[microphonePermissionSnapshot](../../apps/desktop/src/preload/__tests__/microphonePermissionSnapshot.test.ts)；[性能对比与复跑方法](../acceptance/main-thread-stalls-2026-11-02.md) |
| 打开技能列表时校验大量参考文件 | 完整内容指纹校验异步让出主线程，不延长信任缓存；校验中活动版本、清单或已经读取的文件／目录变化时不赋予官方身份；结束时核对文件与目录元数据，录制只保存固定阶段名与耗时 | [built-in-skills](../../apps/desktop/src/main/maker-host/__tests__/built-in-skills.test.ts)、[managed-skills](../../apps/desktop/src/main/maker-host/__tests__/managed-skills.test.ts)、[performanceTrace](../../apps/desktop/src/main/performance-trace/__tests__/performanceTrace.test.ts) |
| 语音浮窗、词典提示窗口初始化 | 辅助窗口只登记麦克风状态读取权限，不升级为 app-content；同步请求含拒绝路径均恰好回复一次；子 frame、未登记窗口和导航后的窗口不能读取或继续收到推送 | [microphonePermissionIpc](../../apps/desktop/src/main/voice-input/__tests__/microphonePermissionIpc.test.ts)、[globalShortcut](../../apps/desktop/src/main/voice-input/__tests__/globalShortcut.test.ts) |
| 长历史中使用 Tab、读取语音设置或调用插件 | Tab 按原生顺序逐步进入离屏控件，不全量展开历史；保留全选、查找和无障碍文本访问；语音热读取不跨进程等待，切换账号失败不泄漏旧快照；插件同次投影复用校验，执行前仍重验精确安装实例 | [messageViewportVirtualization](../../apps/desktop/src/renderer/__tests__/messageViewportVirtualization.test.tsx)、[voiceInputDataSnapshot](../../apps/desktop/src/preload/__tests__/voiceInputDataSnapshot.test.ts)、[GhostManager](../../apps/desktop/src/main/cindy-brain/__tests__/GhostManager.test.ts)、[ghostVisibility](../../apps/desktop/src/main/cindy-brain/__tests__/ghostVisibility.test.ts)、[ghostWorkdirGate](../../apps/desktop/src/main/mcp-integrations/__tests__/ghostWorkdirGate.test.ts) |
| 普通任务与伙伴运行中切换权限 | 以 Host 接受并持久化后的状态为准；失败不假报成功、不发旧状态回滚；确认规则共用 | [sessionPermissionPersistence](../../apps/desktop/src/main/maker-ipc/__tests__/sessionPermissionPersistence.test.ts)、[botPermissionSwitch](../../apps/desktop/src/renderer/features/bots/__tests__/botPermissionSwitch.test.ts)、[permissionMode](../../packages/maker-shared/src/__tests__/permissionMode.test.ts) |
| 重启后发现中断任务、运行中断后续跑 | 启动候选与运行期续跑分别验证；已结束、已清空、已删除等边界不能误续跑 | [sessionActiveTurn](../../apps/desktop/src/main/localDb/__tests__/sessionActiveTurn.test.ts)、[interruptedTurnAutoResume](../../apps/desktop/src/main/maker-ipc/__tests__/interruptedTurnAutoResume.test.ts) |
| 供应商与模型缓存先显示，更新不覆盖手选 | 初值来自现有默认与缓存；任务内手动选择后不被后台默认值重置；伙伴默认与新任务选择独立 | [newMakerDefaultTuple](../../apps/desktop/src/renderer/lib/__tests__/newMakerDefaultTuple.test.ts)、[botDefaultModelChain](../../apps/desktop/src/shared/__tests__/botDefaultModelChain.test.ts) |
| Windows 读取辅助功能树后，刷新或重新打开代码差异 | 未变的高亮节点与文字选区保持；切回时首轮使用已有高亮缓存；高亮代码保留代码语义父节点，避免逐 token 的节点出现事件 | [PlainUnifiedDiff](../../apps/desktop/src/renderer/features/right-sidebar/plugins/review/DiffViewer/__tests__/PlainUnifiedDiff.test.ts) 的统一／分栏刷新与代码语义场景；[highlight](../../apps/desktop/src/renderer/features/right-sidebar/plugins/review/DiffViewer/__tests__/highlight.test.ts) 的首轮缓存与内容变化场景 |

## 按改动选测

在仓库根执行，默认使用既有相关选测：

```sh
pnpm test:unit:related
```

需要复现具体场景时，直接运行对应文件，不依靠提取源码片段来模拟页面。桌面权限入口示例：

```sh
pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/sessionPermissionPersistence.test.ts src/renderer/features/bots/__tests__/botPermissionSwitch.test.ts
```

测试移动到新模块时，应保留静态生产依赖，让关联选测能选中它；共享夹具复用现有 typed fixtures，不再复制一整套页面变量。

## 页面验证记录

单测验证数据和控制流程；用户可见的乐观显示、滚动、导航、滑动和错误提示仍按 [Desktop](desktop-development.md) 规则验收。记录实际工作区、commit、运行中的版本身份、操作、可见结果和截图／日志位置，避免“代码通过了”被误读成“这台设备上的页面已验证”。

遇到新的复现，优先补在表中已有行为测试里，并写出触发条件和用户结果；只有出现新的业务边界时再建模块。本文只链接测试，不复制测试断言，不维护通过次数或临时任务状态。

Windows 审查页的辅助功能回归须在隔离 Electron 中分别检查首次打开、切出再切回、焦点刷新和滚动，覆盖统一／分栏视图。先确认面板真正可见并通过原生 API 读取其内容，再记录主进程的 `BrowserAccessibilityManager::OnAccessibilityEvents`／`NotifyWinEvent`；仅测 renderer 帧率或读取 `accessibilitySupportEnabled` 不能证明 Windows 通知路径没有阻塞。`get_window_state` 等树读取自身可能改变事件生成条件，重启前后的测量不能直接当成同条件对照。
