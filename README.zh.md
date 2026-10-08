# dsh-composer-input-history（输入历史）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 输入框加上终端式的历史输入——就是 opencode 里那种手感。

> 在输入框按 <kbd>↑</kbd>，把本会话里已经发出去的消息调回来；
> 按 <kbd>↓</kbd> 向后翻，翻过最新一条之后，你原来正在写的草稿会恢复。

## 行为

| 操作 | 结果 |
| --- | --- |
| 草稿为空时按 <kbd>↑</kbd> | 调出最新一条已发送消息 |
| 再按 <kbd>↑</kbd> | 每次向前翻一条 |
| 单行草稿（或光标在首行）按 <kbd>↑</kbd> | 调出历史，并记住你原来的草稿 |
| 多行草稿且光标不在首行时按 <kbd>↑</kbd> | 交给编辑器，光标照常上移 |
| 浏览历史时按 <kbd>↓</kbd> | 向后翻一条 |
| 翻过最新一条后再按 <kbd>↓</kbd> | 恢复浏览前的草稿 |
| 浏览历史时手动输入 | 退出浏览，输入内容成为新草稿 |

历史就是本会话自己的消息，从旧到新。它直接取自 Chat 视图渲染用的节点存储（`snapshot.nodes`，按 anchor 序号排序）：普通用户消息、中途引导（steer）消息、以及唤醒一轮的那条消息。被隐藏的节点（压缩或中断）、纯附件消息、以及注入的上下文（指令、技能、目录）都会被跳过。

## 为什么用键盘观察器

Harness 的 composer 明确把 <kbd>↑</kbd>/<kbd>↓</kbd> 留给它自己持有的 Lexical 编辑器，没有 slot 或命令 seam 接管这对按键。因此本插件：

- 在 `conversation.composer.dock` 注册一个不可见的 Session 级占位组件；
- 用标准 `useChat` 钩子读取本会话的 Chat 节点（`snapshot.nodes`），用标准 `useInput` 钩子读取草稿；
- 用标准 `inputActions.setDraft` 写回，使这次替换仍属于 composer 自己的草稿历史；
- 用两条通道盯住按键：document 级 `keydown` 监听，以及 shortcuts 服务的 `observeFixedInput` seam。document 监听在 composer 自己的 keymap 之后运行，所以已打开斜杠菜单或输入法先处理过的按键仍然让行；`observeFixedInput` 则覆盖 Desktop 原生键盘适配器接管 DOM 输入的组合。因为先处理的一方会取消事件，所以实际只有一条通道生效。

以下情况一律放行：斜杠/引用菜单已消费该按键、输入法正在组合、按住了修饰键、事件不在 composer 编辑器内、composer 正在提交或裁决。插件不 import 任何 Harness 客户端包，也不做任何样式。

## 安装

从仓库直接安装（现在即可用）：

```sh
dsh plugin --profile web add https://github.com/liumorrisclaw/dsh-composer-input-history
```

发布到 npm 之后可以用短名：

```sh
dsh plugin --profile web add dsh-composer-input-history
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

针对 `@deepseek-ai/dsh` `0.2.0-rc.2` 开发并验证。只使用有文档的 seam：`ctx.slots`、Session 标准 props（`useChat`、`useInput`、`inputActions`）与 `ctx.shortcuts.observeFixedInput`。`dsh.client.inject` 声明了 `dsh-client-ui-conversation`、`dsh-client-ui-chat`、`dsh-client-shortcuts`，保证激活顺序确定。

## 已验证

- 26 项单测覆盖纯历史读取与浏览状态机（`npm test`），并由 `.github/workflows/ci.yml` 在每次 push 时于 Node 20 与 22 上运行。
- 组合后的 profile 含该 bundle row（`dsh --profile <name> --dump-config`）。
- 浏览器启动图带 inject 列表与 `immediately: true` 公告该 bundle，Web 宿主按字节原样提供 bundle。

尚未用自动化浏览器验证：页面内的实际交互。在运行中的 composer 里按 <kbd>↑</kbd> 就是验收动作。

## 限制

- 历史按 Session 隔离，暂不支持跨会话调取"最近会话"的输入。
- 历史取自当前已加载的 transcript 窗口；被压缩隐藏的消息不会被调出。
- 调回的是纯文本：原消息里的引用 chip 与附件不会恢复。
- 假定每个 Web 页面只有一个常驻 composer，与宿主自身的实现一致。

## 许可

MIT
