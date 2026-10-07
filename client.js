// Browser half of dsh-composer-input-history.
//
// Shell-style input history for the DSH composer:
//   ArrowUp   recalls the messages you already sent in this Session, newest first
//   ArrowDown walks forward again, and past the newest restores the draft you
//             were writing before you started browsing
//
// Why a keyboard observer instead of the shortcut registry: the composer
// deliberately leaves ArrowUp/ArrowDown to its Lexical editor, so no slot or
// command seam owns them. This plugin therefore observes the document keyboard
// feed through the shortcuts service's fixed-input seam, which runs after local
// controls and exposes the original event facts. A key is only taken over when
// the composer still holds it (not consumed by the slash/reference menu or an
// IME), the event targets the composer editor, and the draft can be recalled:
// empty, single-line, or a caret on the first line.
(function () {
  if (typeof window === 'undefined' || window.__ModuleLoader__ === undefined) return;

  window.__ModuleLoader__.load({
    id: 'dsh-composer-input-history',
    factory(require) {
      const React = require('react');

      /** The composer's shell-owned Lexical editor root. */
      const EDITOR_SELECTOR = '[data-lexical-editor="true"]';
      /** Chat node kinds that carry text a human typed (user, steer, waking input). */
      const HUMAN_KINDS = new Set(['user', 'steering', 'turn-trigger']);
      /** Composer phases that refuse draft writes. */
      const LOCKED_PHASES = new Set(['submitting', 'adjudicating']);

      /**
       * Read the typed text of one Chat node.
       * @param node - Chat view node.
       * @returns the node's text blocks joined by newlines, trimmed; '' when none.
       */
      function textOfNode(node) {
        const content = node === null || node === undefined ? undefined : node.data?.content;
        if (!Array.isArray(content)) return '';
        const parts = [];
        for (const block of content) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
        return parts.join('\n').trim();
      }

      /**
       * Collect the Session's sent texts, oldest first.
       * @param nodes - Chat snapshot node list (`legacy.nodes`).
       * @returns recalled texts; attachment-only and injected messages are skipped.
       */
      function historyFromNodes(nodes) {
        if (!Array.isArray(nodes)) return [];
        const history = [];
        for (const node of nodes) {
          if (node === null || typeof node !== 'object') continue;
          if (node.visibility === 'invisible') continue;
          if (!HUMAN_KINDS.has(node.kind)) continue;
          const text = textOfNode(node);
          if (text !== '') history.push(text);
        }
        return history;
      }

      /**
       * Decide whether ArrowUp may start browsing from this draft.
       * @param draft - current draft text.
       * @param caretOnFirstLine - whether a collapsed caret sits on the first rendered line.
       * @returns whether the draft can be replaced by a recalled message.
       */
      function canStartRecall(draft, caretOnFirstLine) {
        const text = typeof draft === 'string' ? draft : '';
        if (text.trim() === '') return true;
        if (caretOnFirstLine === true) return true;
        return !text.includes('\n');
      }

      /**
       * Whether the collapsed selection is on the editor's first rendered line.
       * @param root - composer editor root element.
       * @returns false for a range selection or an unreadable selection.
       */
      function caretOnFirstLine(root) {
        const selection = typeof window === 'undefined' || typeof window.getSelection !== 'function' ? null : window.getSelection();
        if (selection === null || selection === undefined || selection.rangeCount === 0) return false;
        if (!selection.isCollapsed) return false;
        let rect;
        try {
          rect = selection.getRangeAt(0).getBoundingClientRect();
        } catch {
          return false;
        }
        if (rect.width === 0 && rect.height === 0) return true;
        let tolerance = 12;
        try {
          const lineHeight = parseFloat(window.getComputedStyle(root).lineHeight);
          if (Number.isFinite(lineHeight) && lineHeight > 0) tolerance = lineHeight * 0.6;
        } catch {
          /* keep the default tolerance */
        }
        return rect.top - root.getBoundingClientRect().top <= tolerance;
      }

      /**
       * Create the per-Session browse state machine. Pure: it owns no DOM and no React.
       * @returns the navigator used by the keyboard observer.
       */
      function createHistoryNavigator() {
        let browsing = false;
        let index = 0;
        let savedDraft = '';
        let written = null;

        return {
          /** @returns whether a recalled message currently owns the draft. */
          isBrowsing() {
            return browsing;
          },
          /**
           * Leave browsing unless the draft changed to what this navigator wrote.
           * @param text - the draft now published by the composer.
           */
          notifyDraft(text) {
            if (!browsing) return;
            if (written !== null && text === written) return;
            browsing = false;
            written = null;
          },
          /**
           * Step one message older, or start browsing at the newest one.
           * @param args - history, current draft, and caret placement.
           * @returns `{ handled }`, plus the text to publish when handled.
           */
          up({ history, draft, caretOnFirstLine: onFirstLine }) {
            if (!Array.isArray(history) || history.length === 0) return { handled: false };
            if (!browsing) {
              if (!canStartRecall(draft, onFirstLine)) return { handled: false };
              browsing = true;
              savedDraft = typeof draft === 'string' ? draft : '';
              index = history.length - 1;
            } else if (index > 0) {
              index -= 1;
            }
            written = history[index];
            return { handled: true, text: written };
          },
          /**
           * Step one message newer; past the newest, restore the saved draft.
           * @param args - history and current draft.
           * @returns `{ handled }`, plus the text to publish when handled.
           */
          down({ history }) {
            if (!browsing || !Array.isArray(history) || history.length === 0) return { handled: false };
            if (index < history.length - 1) {
              index += 1;
              written = history[index];
              return { handled: true, text: written };
            }
            browsing = false;
            written = null;
            return { handled: true, text: savedDraft };
          },
          /** Drop all browse state, for example when the Session changes. */
          reset() {
            browsing = false;
            index = 0;
            savedDraft = '';
            written = null;
          },
        };
      }

      /**
       * Arbitrate one fixed-input record.
       * @param event - `{ type, gesture, context, consume }` from the shortcuts service.
       * @param refs - live navigator, history, input state, and input actions.
       */
      function handleKey(event, refs) {
        if (event === null || event === undefined || event.type !== 'keydown') return;
        const gesture = event.gesture;
        const context = event.context;
        if (gesture === undefined || gesture === null || context === undefined || context === null) return;
        // Consumed by the composer's own keymap (an open slash/reference menu) or by an IME.
        if (gesture.defaultPrevented || gesture.composing) return;
        if (gesture.control || gesture.alt || gesture.meta || gesture.shift) return;
        if (gesture.code !== 'ArrowUp' && gesture.code !== 'ArrowDown') return;
        const target = context.target;
        if (target === null || target === undefined || typeof target.closest !== 'function') return;
        const root = target.closest(EDITOR_SELECTOR);
        if (root === null) return;

        const input = refs.inputRef.current;
        const actions = refs.actionsRef.current;
        if (input === undefined || input === null || actions === undefined || actions === null) return;
        if (typeof actions.setDraft !== 'function') return;
        if (LOCKED_PHASES.has(input.phase)) return;

        const draft = typeof input.draft === 'string' ? input.draft : '';
        const nav = refs.nav;
        const result = gesture.code === 'ArrowUp'
          ? nav.up({ history: refs.historyRef.current, draft, caretOnFirstLine: caretOnFirstLine(root) })
          : nav.down({ history: refs.historyRef.current, draft });
        if (result.handled !== true) return;

        // Cancel the browser's caret move before the default action runs.
        event.consume();
        if (typeof result.text === 'string' && result.text !== draft) actions.setDraft(result.text);
      }

      /**
       * Invisible Session-scoped occupant: it owns this Session's browse state and
       * the keyboard observer, and renders nothing.
       * @param props - standard Session props (`useChat`, `useInput`, `inputActions`).
       * @returns null.
       */
      function InputHistory(props) {
        // The Session standard kit always supplies both hooks; stay inert rather
        // than crash the dock entry if another composition omits one.
        const useChatHook = typeof props.useChat === 'function' ? props.useChat : null;
        const useInputHook = typeof props.useInput === 'function' ? props.useInput : null;
        const nodes = useChatHook === null ? undefined : useChatHook((snapshot) => (snapshot === null || snapshot === undefined ? undefined : snapshot.legacy?.nodes));
        const input = useInputHook === null ? undefined : useInputHook((state) => state);

        const navRef = React.useRef(null);
        if (navRef.current === null) navRef.current = createHistoryNavigator();
        const nav = navRef.current;

        const history = React.useMemo(() => historyFromNodes(nodes), [nodes]);
        const historyRef = React.useRef(history);
        historyRef.current = history;

        const inputRef = React.useRef(input);
        inputRef.current = input;

        const actionsRef = React.useRef(props.inputActions);
        actionsRef.current = props.inputActions;

        // Typing, a command, or a send leaves browse mode at once.
        React.useEffect(() => {
          nav.notifyDraft(input !== null && input !== undefined && typeof input.draft === 'string' ? input.draft : '');
        }, [nav, input]);

        // Observe the window keyboard feed while this Session's composer is mounted.
        React.useEffect(() => {
          const shortcuts = ctx.shortcuts;
          if (shortcuts === undefined || shortcuts === null || typeof shortcuts.observeFixedInput !== 'function') return undefined;
          return shortcuts.observeFixedInput((event) => {
            handleKey(event, { nav, historyRef, inputRef, actionsRef });
          });
        }, [nav]);

        return null;
      }

      return {
        inject: ['slots', 'shortcuts'],
        apply(ctx) {
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'input-history',
            order: 20,
          }, InputHistory));
        },
        /** Pure helpers, exposed for the package's own tests. */
        __test: { textOfNode, historyFromNodes, createHistoryNavigator, canStartRecall, handleKey },
      };
    },
  });
})();
