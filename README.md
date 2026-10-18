# dsh-composer-input-history

Shell-style input history for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web composer — the behaviour you know from opencode and other terminal agents.

> Press <kbd>↑</kbd> in the composer to pull back a message you already sent in this Session.
> Press <kbd>↓</kbd> to walk forward again; past the newest message your original draft comes back,
> and one more <kbd>↓</kbd> discards it and clears the composer.

## What it does

| Gesture | Behaviour |
| --- | --- |
| <kbd>↑</kbd> with an empty draft | recalls the newest sent message |
| <kbd>↑</kbd> again | walks one message older each time |
| <kbd>↑</kbd> on the first line of a single-line draft | recalls; the draft you were writing is remembered |
| <kbd>↑</kbd> inside a multi-line draft, below the first line | left to the editor, so the caret still moves |
| <kbd>↓</kbd> while browsing | walks one message newer |
| <kbd>↓</kbd> past the newest message | restores the draft you were writing before browsing |
| <kbd>↓</kbd> again, after the draft came back | discards the draft and clears the composer |
| typing anything while browsing | leaves browse mode; the recalled text becomes your draft |

History is what you sent in this Session, oldest to newest, read from the Chat node store the view itself renders (`snapshot.nodes`, ordered by anchor sequence): ordinary user messages, steering messages, and the message that woke a turn. Skipped: hidden nodes (compacted or interrupted), attachment-only messages, and everything the Harness authors on your behalf — goal rounds, skill catalogs, runtime snapshots, job notices, model notices, approval answers, and compaction checkpoints. The visible window is also persisted per Session in `localStorage` (capped at 300 entries) and merged with the live store, so messages a compaction pruned stay recallable, including after a restart.

## Why it is a keyboard observer

The Harness composer deliberately leaves <kbd>↑</kbd>/<kbd>↓</kbd> to its shell-owned Lexical editor, so no slot or command seam owns them. This plugin therefore:

- registers an invisible Session-scoped occupant in `conversation.composer.dock`;
- reads the Session's Chat nodes through the standard `useChat` hook (`snapshot.nodes`) and the draft through the standard `useInput` hook;
- writes the recalled text through the standard `inputActions.setDraft` API, so the edit stays part of the composer's own draft history;
- watches the key on two paths: a document-level `keydown` listener and the shortcuts service's `observeFixedInput` seam. The document listener runs after the composer's own keymap, so a slash menu or an IME that already handled the key still wins; the fixed-input seam covers compositions where a native Desktop adapter owns the DOM feed. Exactly one path acts, because the first one to act cancels the event.

Replacing a draft commits paragraph by paragraph, so intermediate empty or partial drafts are expected; the plugin treats a published draft that matches what it wrote (ignoring whitespace) as its own and keeps browse mode. Only a genuinely visible slash/reference menu (a mounted `role="listbox"`), an IME composition, or a held modifier keeps the key — a caret move the editor already marked as handled does not. Editing keys (Backspace, Delete, Enter, printable characters, <kbd>Ctrl+V</kbd>/<kbd>Ctrl+X</kbd>) end browse mode; navigation keys and shortcuts such as <kbd>Ctrl+C</kbd> do not. The browse state machine itself is cached per composer editor element, so re-rendering or remounting the dock entry never drops the browse state or the remembered draft, and starting browse again from an already-recalled message never overwrites the draft you were writing — walking past the newest message always lands on that draft, a blank composer included. When the host re-seeds a stale stored draft over a restore, the plugin re-asserts the restored text (the counter-punch yields only to genuine text editing, not to arrow keys), and every handled key re-arms that defense for the text it just published.

A key is declined when an open menu owns it, when an IME is composing, when a modifier is held, when the event is outside the composer editor, or when the composer is submitting/adjudicating. The plugin imports no Harness Client package and styles nothing.

## Install

From this repository (available now):

```sh
dsh plugin --profile web add https://github.com/liumorrisclaw/dsh-composer-input-history
```

Once the package is on npm, the short form is:

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

Developed and verified against `@deepseek-ai/dsh` `0.2.0-rc.2`. The plugin uses only documented seams: `ctx.slots`, the Session standard props (`useChat`, `useInput`, `inputActions`), `ctx.shortcuts.observeFixedInput`, and the activation context's `uiSession` binding source (declared in `dsh.client.inject`). It declares `dsh.client.inject` on `dsh-client-ui-conversation`, `dsh-client-ui-chat`, and `dsh-client-shortcuts` so activation order is deterministic.

## Verified

- 48 tests (`npm test`): 40 unit tests over the pure history reader, the browse navigator, and keystroke arbitration, plus 6 simulated-composer integration tests that mount the real bundle against a stub React host and stub DOM — whole-draft publish, the stale-draft refill and its counter-punch, compaction pruning merged with the persistent record, manual edits, menu yields, and IME declines.
- The composed profile contains the bundle row (`dsh --profile <name> --dump-config`).
- The browser boot graph announces the bundle with its inject list and `immediately: true`, and the web host serves the bundle body byte-for-byte.
- End-to-end in a real harness Web instance driven over the DevTools protocol: the dock entry mounts in a session composer, <kbd>↑</kbd> recalls the sent message, walking down lands on the draft and a further <kbd>↓</kbd> clears it, a typed draft survives rapid up/down walks, and the console stays clean.
- Recalling a message with <kbd>↑</kbd> was confirmed by hand in a running Desktop composer.

## Limitations

- History is per Session. Cross-session recall (recent Sessions' inputs) is not implemented yet.
- History reflects the loaded transcript window plus the persisted per-Session record; a message never seen by this plugin (sent while it was uninstalled) is not recalled.
- The recalled text is plain text: reference chips and attachments from the original message are not restored.
- One resident composer per Web page is assumed, matching the shell's own design.
- On the home screen (no Session open) there is no recall: the composer dock only renders inside a session.

## License

MIT
