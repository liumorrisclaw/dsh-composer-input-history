# dsh-input-history

Shell-style input history for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web composer — the behaviour you know from opencode and other terminal agents.

> Press <kbd>↑</kbd> in the composer to pull back a message you already sent in this Session.
> Press <kbd>↓</kbd> to walk forward again; past the newest message your original draft comes back.

## What it does

| Gesture | Behaviour |
| --- | --- |
| <kbd>↑</kbd> with an empty draft | recalls the newest sent message |
| <kbd>↑</kbd> again | walks one message older each time |
| <kbd>↑</kbd> on the first line of a single-line draft | recalls; the draft you were writing is remembered |
| <kbd>↑</kbd> inside a multi-line draft, below the first line | left to the editor, so the caret still moves |
| <kbd>↓</kbd> while browsing | walks one message newer |
| <kbd>↓</kbd> past the newest message | restores the draft you were writing before browsing |
| typing anything while browsing | leaves browse mode; the recalled text becomes your draft |

History is the current Session's own messages, oldest to newest: ordinary user messages, steering messages, and the message that woke a turn. Attachment-only messages and injected context (instructions, skills, catalogs) are skipped.

## Why it is a keyboard observer

The Harness composer deliberately leaves <kbd>↑</kbd>/<kbd>↓</kbd> to its shell-owned Lexical editor, so no slot or command seam owns them. This plugin therefore:

- registers an invisible Session-scoped occupant in `conversation.composer.dock`;
- reads the Session's Chat snapshot through the standard `useChat` hook and the draft through the standard `useInput` hook;
- writes the recalled text through the standard `inputActions.setDraft` API, so the edit stays part of the composer's own draft history;
- observes the document keyboard feed through the shortcuts service's `observeFixedInput` seam, which runs after local controls and exposes the original event facts, and only consumes the key when the composer still owns it.

A key is declined when the slash/reference menu already consumed it, when an IME is composing, when a modifier is held, when the event is outside the composer editor, or when the composer is submitting/adjudicating. The plugin imports no Harness Client package and styles nothing.

## Install

From a profile:

```sh
dsh plugin --profile web add dsh-composer-input-history
```

Or add it in the Web UI's **Plugins** page, or list the package directory with the plugin manager. The bundle ships off until the profile selects it.

For a local checkout, install by path:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-composer-input-history
```

## Relationship to other plugins

The npm name `dsh-input-history` is already taken by a different community plugin that also recalls prompts with <kbd>↑</kbd>/<kbd>↓</kbd>. The two differ in mechanism and behaviour:

| | dsh-composer-input-history (this plugin) | dsh-input-history |
| --- | --- | --- |
| History source | the Session transcript the Chat view already loads | a separate local store of submitted prompts |
| Non-empty draft | recalls and remembers the draft, restoring it below the newest message | recalls only from an empty composer |
| Attachments | not part of the recalled text | persists and re-attaches them |
| Menu/IME | yields the key to an open slash/reference menu and to IME composition | — |

Pick this one if you want recall driven by the conversation you can see, including from a draft you are already typing.

## Compatibility

Developed and verified against `@deepseek-ai/dsh` `0.2.0-rc.2`. The plugin uses only documented seams: `ctx.slots`, the Session standard props (`useChat`, `useInput`, `inputActions`), and `ctx.shortcuts.observeFixedInput`. It declares `dsh.client.inject` on `dsh-client-ui-conversation`, `dsh-client-ui-chat`, and `dsh-client-shortcuts` so activation order is deterministic.

## Verified

- 23 unit tests over the pure history reader and browse state machine (`npm test`), run on every push by `.github/workflows/ci.yml` on Node 20 and 22.
- The composed profile contains the bundle row (`dsh --profile <name> --dump-config`).
- The browser boot graph announces the bundle with its inject list and `immediately: true`, and the web host serves the bundle body byte-for-byte.

Not yet verified by automated browser control: the in-page interaction itself. Pressing <kbd>↑</kbd> in a running composer is the acceptance check.

## Limitations

- History is per Session. Cross-session recall (recent Sessions' inputs) is not implemented yet.
- History reflects the loaded transcript window; messages hidden by compaction are not recalled.
- The recalled text is plain text: reference chips and attachments from the original message are not restored.
- One resident composer per Web page is assumed, matching the shell's own design.

## License

MIT
