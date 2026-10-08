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
       * Read the typed text of one Chat node. Legacy projections carry a node's
       * data directly, so a data-only entry is accepted as well.
       * @param node - Chat view node, or its data.
       * @returns the node's text blocks joined by newlines, trimmed; '' when none.
       */
      function textOfNode(node) {
        if (node === null || node === undefined) return '';
        const data = node.data === undefined || node.data === null ? node : node.data;
        if (data === null || typeof data !== 'object') return '';
        if (typeof data.content === 'string') return data.content.trim();
        if (Array.isArray(data.content)) {
          const parts = [];
          for (const block of data.content) {
            if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
          }
          return parts.join('\n').trim();
        }
        if (typeof data.text === 'string') return data.text.trim();
        return '';
      }

      /**
       * Read the ordered Chat nodes out of the Session Chat store.
       * @param store - `snapshot.nodes`, the store facade or a plain Map.
       * @returns Chat view nodes; [] for an unknown shape.
       */
      function nodesFromStore(store) {
        if (store === null || store === undefined) return [];
        if (Array.isArray(store)) return store;
        if (typeof store.values === 'function') {
          const value = store.values();
          if (Array.isArray(value)) return value;
          if (value !== null && value !== undefined && typeof value[Symbol.iterator] === 'function') return [...value];
        }
        return [];
      }

      /**
       * Collect the Session's sent texts, oldest first.
       * @param nodes - Chat view nodes, in any order.
       * @returns recalled texts; hidden, injected, and attachment-only messages are skipped.
       */
      function historyFromNodes(nodes) {
        if (!Array.isArray(nodes) || nodes.length === 0) return [];
        const order = (node) => {
          if (node !== null && node !== undefined && typeof node.anchorSeq === 'number') return node.anchorSeq;
          const seq = node === null || node === undefined || node.data === null || node.data === undefined ? undefined : node.data.seq;
          return typeof seq === 'number' ? seq : 0;
        };
        const ordered = [...nodes].sort((left, right) => order(left) - order(right));
        const history = [];
        for (const node of ordered) {
          if (node === null || node === undefined || typeof node !== 'object') continue;
          // Hidden nodes (compacted or interrupted) are not recallable.
          if (node.visibility !== undefined && node.visibility !== 'visible') continue;
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

      /* Opt-in in-page diagnostics: off by default in the shipped package. While
         developing, flip DEBUG_ENABLED here (or set window.__DSH_INPUT_HISTORY_DEBUG
         before the bundle loads) to render a status pill and expose
         window.__dshInputHistory with the latest arbitration reason. */
      const DEBUG_ENABLED = false;
      const DEBUG = DEBUG_ENABLED || (typeof window !== 'undefined' && window.__DSH_INPUT_HISTORY_DEBUG === true);
      const debugState = { mounted: 0, observer: 'none', keydowns: 0, domKeydowns: 0, arrows: 0, recalled: 0, path: 'none', last: 'start' };
      const debugNodes = new Set();
      function paintDebug() {
        if (!DEBUG) return;
        if (typeof window !== 'undefined') window.__dshInputHistory = { ...debugState };
        const text = 'IH m=' + debugState.mounted + ' obs=' + debugState.observer + ' dom=' + debugState.domKeydowns + ' k=' + debugState.keydowns + ' a=' + debugState.arrows + ' r=' + debugState.recalled + ' path=' + debugState.path + ' last=' + debugState.last;
        for (const node of debugNodes) {
          try {
            node.textContent = text;
          } catch {
            /* the node may be detached */
          }
        }
      }
      function noteDebug(reason) {
        if (!DEBUG) return;
        debugState.last = reason;
        paintDebug();
      }

      /**
       * Arbitrate one fixed-input record.
       * @param event - `{ type, gesture, context, consume }` from the shortcuts service.
       * @param refs - live navigator, history, input state, and input actions.
       */
      function handleKey(event, refs, path = 'fixed') {
        if (event === null || event === undefined || event.type !== 'keydown') { noteDebug('non-keydown'); return; }
        if (path === 'dom') debugState.domKeydowns += 1;
        else debugState.keydowns += 1;
        const gesture = event.gesture;
        const context = event.context;
        if (gesture === undefined || gesture === null || context === undefined || context === null) { noteDebug('bad-record'); return; }
        // Consumed by the composer's own keymap (an open slash/reference menu) or by an IME.
        if (gesture.defaultPrevented || gesture.composing) { noteDebug(gesture.defaultPrevented ? 'consumed-upstream' : 'composing'); return; }
        if (gesture.control || gesture.alt || gesture.meta || gesture.shift) { noteDebug('modifier'); return; }
        if (gesture.code !== 'ArrowUp' && gesture.code !== 'ArrowDown') { noteDebug('other-key:' + gesture.code); return; }
        debugState.arrows += 1;
        debugState.path = path;
        const target = context.target;
        if (target === null || target === undefined || typeof target.closest !== 'function') { noteDebug('no-target'); return; }
        const root = target.closest(EDITOR_SELECTOR);
        if (root === null) { noteDebug('not-editor'); return; }

        const input = refs.inputRef.current;
        const actions = refs.actionsRef.current;
        if (input === undefined || input === null || actions === undefined || actions === null) { noteDebug('no-input'); return; }
        if (typeof actions.setDraft !== 'function') { noteDebug('no-setDraft'); return; }
        if (LOCKED_PHASES.has(input.phase)) { noteDebug('locked:' + input.phase); return; }

        const draft = typeof input.draft === 'string' ? input.draft : '';
        const nav = refs.nav;
        const history = refs.historyRef.current;
        const result = gesture.code === 'ArrowUp'
          ? nav.up({ history, draft, caretOnFirstLine: caretOnFirstLine(root) })
          : nav.down({ history, draft });
        if (result.handled !== true) { noteDebug('refused:' + gesture.code + ' n=' + (Array.isArray(history) ? history.length : 'x')); return; }

        debugState.recalled += 1;
        // Cancel the browser's caret move before the default action runs.
        event.consume();
        if (typeof result.text === 'string' && result.text !== draft) actions.setDraft(result.text);
        noteDebug('handled:' + gesture.code);
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
        const nodes = useChatHook === null ? undefined : useChatHook((snapshot) => (snapshot === null || snapshot === undefined ? undefined : nodesFromStore(snapshot.nodes)));
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

        // Two keyboard paths on purpose: Desktop owns its keys through a native
        // adapter, so the shared fixed-input feed may be absent or bypassed there,
        // while on Web nothing claims ArrowUp/ArrowDown at all.
        React.useEffect(() => {
          debugState.mounted += 1;
          const refs = { nav, historyRef, inputRef, actionsRef };

          // Primary path: our own listener on the document. It runs after the
          // composer's own keymap handled the key, so an open slash/reference menu
          // or an IME that already consumed it still wins.
          let onKeyDown = null;
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            onKeyDown = (domEvent) => {
              handleKey({
                type: 'keydown',
                gesture: {
                  code: domEvent.code,
                  control: domEvent.ctrlKey,
                  alt: domEvent.altKey,
                  meta: domEvent.metaKey,
                  shift: domEvent.shiftKey,
                  repeat: domEvent.repeat,
                  composing: domEvent.isComposing === true,
                  defaultPrevented: domEvent.defaultPrevented,
                },
                context: { region: 'editable', target: domEvent.target },
                consume: () => domEvent.preventDefault(),
              }, refs, 'dom');
            };
            document.addEventListener('keydown', onKeyDown);
          } else {
            debugState.observer = 'no-dom';
          }

          // Secondary path: the shared fixed-input feed, when this composition has one.
          const shortcuts = ctx.shortcuts;
          let off = () => {};
          if (shortcuts !== undefined && shortcuts !== null && typeof shortcuts.observeFixedInput === 'function') {
            debugState.observer = debugState.observer === 'no-dom' ? 'no-dom' : 'installed';
            off = shortcuts.observeFixedInput((event) => {
              handleKey(event, refs, 'fixed');
            });
          } else if (debugState.observer === 'none') {
            debugState.observer = 'missing';
          }
          paintDebug();

          return () => {
            if (onKeyDown !== null) document.removeEventListener('keydown', onKeyDown);
            off();
            debugState.mounted -= 1;
            paintDebug();
          };
        }, [nav]);

        // Optional diagnostic pill, rendered only while DEBUG is on.
        if (!DEBUG) return null;
        return React.createElement('span', {
          ref: (node) => {
            if (node === null) return;
            debugNodes.add(node);
            paintDebug();
          },
          'data-dsh-input-history-debug': '1',
          style: {
            font: '10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--dsw-alias-text-tertiary, #8a8a8a)',
            padding: '2px 6px',
            pointerEvents: 'none',
          },
        }, 'IH');
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
        __test: { textOfNode, nodesFromStore, historyFromNodes, createHistoryNavigator, canStartRecall, handleKey },
      };
    },
  });
})();
