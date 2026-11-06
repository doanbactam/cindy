## 5.1 远程设置页的操作来源（`mobile` 声明已停用）

Cindy 已不再提供手机端，插件手机页面随之下线。身份卡顶层的 `mobile` 字段仍可通过校验并被
原样保留，已装插件照旧安装、批准和使用；但宿主忽略它，不会再为它打开任何页面。新插件不要
声明 `mobile`，也不要为它准备专门的 HTML。

另一台电脑可以远程打开插件原有的 `settingsHtml`。这个设置页经 BroadcastChannel 发给电脑
逻辑页的消息仍带 Host 附上的不透明 `mobilePageId`（覆盖页面自报的值，名称为兼容保留）：

- 异步链显式保留它；confirm、notify、tasks、pick、pickModel、workspace 等请求原样附带，
  确认框、目录选择和模型选择才会出现在发起操作的那台控制电脑上。
- 示例：`const origin = msg.mobilePageId; const answer = await cindy.confirm({ body: "应用调整？", ...(origin ? { mobilePageId: origin } : {}) });`
  只有 `answer.ok && answer.confirmed` 才能继续；页面关闭、超时或撤权均不能当成同意。
- 不要把它存为全局"最近来源"，也不能在后台复用过期来源；设置页关闭后带旧值的请求会失败。
- 凭证、OAuth、连接不走业务频道，必须使用 Host 原生配置流程。
