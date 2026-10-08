# Changelog

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
