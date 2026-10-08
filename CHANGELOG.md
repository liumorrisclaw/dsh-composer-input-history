# Changelog

## 0.1.0

First release.

- <kbd>↑</kbd> recalls the messages already sent in the current Session, newest first.
- <kbd>↓</kbd> walks forward again and, past the newest message, restores the draft that was being written.
- Recall works from an empty draft, a single-line draft, or a caret on the first line; a caret below the first line of a multi-line draft keeps its normal move.
- An open slash/reference menu, IME composition, held modifiers, other editable surfaces, and locked composer phases all keep the key.
- Reads the Session transcript through the standard `useChat` hook, writes through `inputActions.setDraft`, and observes the keyboard through `ctx.shortcuts.observeFixedInput`.
- 23 unit tests cover the history reader and the browse state machine.
