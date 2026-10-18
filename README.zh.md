# dsh-composer-input-history（输入历史）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 输入框加上终端式的历史输入——就是 opencode 里那种手感。

> 在输入框按 <kbd>↑</kbd>，把本会话里已经发出去的消息调回来；
> 按 <kbd>↓</kbd> 向后翻，翻过最新一条之后，你原来正在写的草稿会恢复；
> 再按一次 <kbd>↓</kbd>，丢弃草稿、清空输入框。

## 行为

| 操作 | 结果 |
| --- | --- |
| 草稿为空时按 <kbd>↑</kbd> | 调出最新一条已发送消息 |
| 再按 <kbd>↑</kbd> | 每次向前翻一条 |
| 单行草稿（或光标在首行）按 <kbd>↑</kbd> | 调出历史，并记住你原来的草稿 |
| 多行草稿且光标不在首行时按 <kbd>↑</kbd> | 交给编辑器，光标照常上移 |
| 浏览历史时按 <kbd>↓</kbd> | 向后翻一条 |
| 翻过最新一条后再按 <kbd>↓</kbd> | 恢复浏览前的草稿 |
| 草稿恢复后再按一次 <kbd>↓</kbd> | 丢弃草稿，清空输入框 |
| 浏览历史时手动输入 | 退出浏览，输入内容成为新草稿 |

历史就是**你自己发出去的内容**，从旧到新。它直接取自 Chat 视图渲染用的节点存储（`snapshot.nodes`，按 anchor 序号排序）：普通用户消息、中途引导（steer）消息、以及唤醒一轮的那条消息。以下一律跳过：被隐藏的节点（压缩或中断）、纯附件消息，以及 Harness 代你生成的一切——goal 轮次提示、技能目录、运行时快照、任务通知、模型切换通知、审批回答、压缩检查点。可见窗口还会按会话持久化到 `localStorage`（上限 300 条）并与实时存储合并，因此被压缩裁剪掉的消息依然可以调出，重启之后也有效。

## 为什么用键盘观察器

Harness 的 composer 明确把 <kbd>↑</kbd>/<kbd>↓</kbd> 留给它自己持有的 Lexical 编辑器，没有 slot 或命令 seam 接管这对按键。因此本插件：

- 在 `conversation.composer.dock` 注册一个不可见的 Session 级占位组件；
- 用标准 `useChat` 钩子读取本会话的 Chat 节点（`snapshot.nodes`），用标准 `useInput` 钩子读取草稿；
- 用标准 `inputActions.setDraft` 写回，使这次替换仍属于 composer 自己的草稿历史；
- 用两条通道盯住按键：document 级 `keydown` 监听，以及 shortcuts 服务的 `observeFixedInput` seam。document 监听在 composer 自己的 keymap 之后运行，所以已打开斜杠菜单或输入法先处理过的按键仍然让行；`observeFixedInput` 则覆盖 Desktop 原生键盘适配器接管 DOM 输入的组合。因为先处理的一方会取消事件，所以实际只有一条通道生效。

替换草稿是**按段落重建**的，所以写入过程中出现空草稿或只写了一部分都属于正常中间态；只要发布出来的草稿与插件写入的内容一致（忽略所有空白），就视为"我自己的写入"并继续保持浏览模式。只有**确实打开的**斜杠/引用菜单（页面上挂载了可见的 `role="listbox"`）、输入法组合、或按住修饰键时才让行——编辑器自己标记为"已处理"的光标移动不再阻止插件。真正改文本的按键（退格、删除、回车、可打印字符、<kbd>Ctrl+V</kbd>/<kbd>Ctrl+X</kbd>）会退出浏览模式；方向键与 <kbd>Ctrl+C</kbd> 这类快捷键不会。浏览状态机本身按 **composer 编辑器元素**缓存，因此 dock 条目重渲染或重挂载都不会丢掉浏览状态与记住的草稿；另外，从"已调回的消息"再次开始浏览时不会再覆盖你原来的草稿——往下翻过最新一条后一定落到那份草稿上（空输入框也算），再按一次 <kbd>↓</kbd> 则丢弃草稿清空输入框。当宿主把过期草稿重新铺回来时，插件会把恢复的文本重新断言回去（这套反击只对真正的文本编辑让步，方向键不影响它）；每次成功导航也都会把反击的防守文本更新为刚刚发布的内容。

以下情况一律放行：菜单打开并拥有该按键、输入法正在组合、按住了修饰键、事件不在 composer 编辑器内、composer 正在提交或裁决。插件不 import 任何 Harness 客户端包，也不做任何样式。

## 安装

从 npm 安装（短名）：

```sh
dsh plugin --profile web add dsh-composer-input-history
```

或直接从仓库安装：

```sh
dsh plugin --profile web add https://github.com/liumorrisclaw/dsh-composer-input-history
```

也可以在 Web 界面的 **Plugins** 页安装，或用插件管理器直接选择本地包目录。默认关闭，需要由 profile 选中后启用。

本地 checkout 可按路径安装：

```sh
dsh plugin --profile web add /绝对/路径/dsh-composer-input-history
```

## 与已有插件的关系

npm 上的 `dsh-input-history` 已被另一个社区插件占用，它同样用 <kbd>↑</kbd>/<kbd>↓</kbd> 调回提示词。两者的机制和行为不同：

| | dsh-composer-input-history（本插件） | dsh-input-history |
| --- | --- | --- |
| 历史来源 | Chat 界面已经加载的本会话 transcript | 单独在本地保存已提交提示词 |
| 非空草稿 | 可调回，并记住原草稿，翻过最新一条后恢复 | 仅在空输入框时调回 |
| 附件 | 不随调回的文本恢复 | 会保存并重新附上 |
| 菜单/输入法 | 让开已打开的斜杠/引用菜单与输入法组合 | — |

如果你希望历史来自你眼前这段会话、并且从正在输入的草稿里也能调回，就选本插件。

## 兼容性

针对 `@deepseek-ai/dsh` `0.2.0-rc.2` 开发并验证。只使用有文档的 seam：`ctx.slots`、Session 标准 props（`useChat`、`useInput`、`inputActions`）、`ctx.shortcuts.observeFixedInput`，以及激活上下文里的 `uiSession` 绑定源（已在 `dsh.client.inject` 声明）。`dsh.client.inject` 声明了 `dsh-client-ui-conversation`、`dsh-client-ui-chat`、`dsh-client-shortcuts`，保证激活顺序确定。

## 已验证

- 48 项测试（`npm test`）：40 项单测覆盖纯历史读取、浏览导航器与按键仲裁；6 项模拟 composer 集成测试把真实 bundle 挂到桩 React 宿主与桩 DOM 上——覆盖整段草稿发布、过期草稿顶回及其反击、压缩裁剪与持久记录合并、手动编辑、菜单让行、输入法拒绝。
- 组合后的 profile 含该 bundle row（`dsh --profile <name> --dump-config`）。
- 浏览器启动图带 inject 列表与 `immediately: true` 公告该 bundle，Web 宿主按字节原样提供 bundle。
- 通过 DevTools 协议驱动真实 harness Web 实例完成端到端验证：会话 composer 中 dock 条目正常挂载，<kbd>↑</kbd> 召回已发送消息，向下走到草稿、再按一次 <kbd>↓</kbd> 清空，快速上下往返草稿完整保留，控制台无报错。
- 在运行中的 Desktop composer 里手工确认了 <kbd>↑</kbd> 能调回消息。

## 限制

- 历史按 Session 隔离，暂不支持跨会话调取"最近会话"的输入。
- 历史取自当前已加载的 transcript 窗口加持久化的会话记录；插件未见过（卸载期间发送）的消息不会被调出。
- 调回的是纯文本：原消息里的引用 chip 与附件不会恢复。
- 假定每个 Web 页面只有一个常驻 composer，与宿主自身的实现一致。
- 首页（未进入会话）没有召回：composer dock 只在会话内渲染。

## 许可

MIT
