# Changelog

## 0.1.2

Hardens browse mode, restores it inside a live Session, and makes walking down always able to clear the composer.

- The dock entry now declares the `uiSession` service it reads the Session id from. An undeclared scoped-context access used to throw inside the component on every render, so the entry never committed and the keyboard stayed dead even inside a session.
- Walking down past the newest message now has three stops: the remembered draft comes back first, and one more <kbd>↓</kbd> discards it and clears the composer — a paste you changed your mind about can be dropped from the keyboard. An empty starting draft still ends at a blank composer directly, and <kbd>↑</kbd> after a discard starts the ladder again from the newest message.
- The refill counter-punch (which re-asserts a restored draft when the host re-seeds a stale one) now only yields to genuine text editing — typing, deleting, pasting — not to arrow keys, so rapid up/down walks keep the restored text intact.
- Every handled key re-arms the refill defense for the text it just published, registered before the draft lands: the host re-renders during `setDraft`, and the counter must defend the newest publish, not an older restore.
- The dock entry declares its services (`slots`, `shortcuts`, `uiSession`) and reads the Session id from the activation context's binding source, guarded end to end so a scoped context that refuses undeclared access cannot break rendering.
- Per-Session history now also persists to `localStorage` (capped at 300 entries) and merges with the live Chat store, so messages a compaction pruned stay recallable, including across restarts.
- Replacing the draft commits paragraph by paragraph, so intermediate empty or partial drafts are normal. A published draft that matches what the plugin wrote (ignoring whitespace, and including such a partial state) is no longer mistaken for a manual edit, which used to end browse mode and drop the remembered draft.
- Only a genuinely visible slash/reference menu (a mounted `role="listbox"`), an IME composition, or a held modifier keeps the key. A caret move the editor already marked as handled no longer blocks browsing.
- Editing keys (Backspace, Delete, Enter, printable characters, Ctrl+V/Ctrl+X) end browse mode; arrow keys and shortcuts such as Ctrl+C do not.
- The browse state machine is cached per composer editor element, so re-rendering or remounting the dock entry no longer drops the browse state and the remembered draft.
- Restarting browse from an already-recalled message no longer overwrites the draft you were writing, so walking forward always lands on that draft — a blank composer included.
- Keyboard records resolve the editor through the DOM event path first, which also covers shadow boundaries.
- 48 tests (was 27): 40 unit tests over the reader, the navigator, and keystroke arbitration, plus 6 simulated-composer integration tests that mount the real bundle against a stub React host and stub DOM — covering whole-draft publish, the stale-draft refill and its counter-punch, compaction pruning merged with the persistent record, manual edits, menu yields, and IME declines.

## 0.1.1

Fixes a reader bug that left the history empty inside a running composer.

- History is now read from the Chat node store the view itself renders (`snapshot.nodes`, ordered by anchor sequence) instead of the legacy projection `legacy.nodes`. That projection carries token/step usage data, so 0.1.0 never found any message text.
- Nodes whose visibility is not `visible` (compacted or interrupted) are skipped, matching the view's own visibility rule.
- The keyboard is watched on two paths: a document-level `keydown` listener, which also covers Desktop where a native adapter owns the input feed, and the shortcuts `observeFixedInput` seam. Whichever acts first cancels the event, so exactly one path handles a key.
- The reader also accepts legacy data-only entries and plain string content.
- Messages the Harness authors on the user's behalf are skipped by provenance: goal rounds, skill catalogs, runtime snapshots, job notices, model notices, approval answers, and compaction checkpoints.
- 27 unit tests (was 23), including the real Chat node shape, ordering, hidden-node filtering, and provenance.

## 0.1.0

First release.

- <kbd>↑</kbd> recalls the messages already sent in the current Session, newest first.
- <kbd>↓</kbd> walks forward again and, past the newest message, restores the draft that was being written.
- Recall works from an empty draft, a single-line draft, or a caret on the first line; a caret below the first line of a multi-line draft keeps its normal move.
- An open slash/reference menu, IME composition, held modifiers, other editable surfaces, and locked composer phases all keep the key.
- Reads the Session transcript through the standard `useChat` hook, writes through `inputActions.setDraft`, and observes the keyboard through `ctx.shortcuts.observeFixedInput`.
- 16 unit tests cover the history reader and the browse state machine.
