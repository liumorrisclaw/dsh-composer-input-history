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
      /** Timestamp of the last physical keydown, used to attribute draft changes. */
      let lastKeydownAt = 0;
      /** Timestamp of the last text-editing keydown (typing, deleting, pasting). */
      let lastTextEditAt = 0;
      /** The activation context, captured in apply() for the mounted component. */
      let applyContext = null;
      /** Refs of the currently mounted dock entry; the activation-time feed uses them. */
      let activeRefs = null;
      /** Message provenance the Harness authors for the user; never part of the history. */
      const INJECTED_SOURCE_KINDS = new Set([
        'goal',
        'runtime-context',
        'skill-catalog',
        'tool-jobs',
        'model-selection',
        'compact-checkpoint',
        'user-approval',
        'command',
        'system',
      ]);

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
          const data = node.data === undefined || node.data === null ? node : node.data;
          const sourceKind = data === null || typeof data !== 'object' ? undefined : data.source?.kind;
          // Harness-authored messages the Session carries on the user's behalf
          // (goal rounds, catalogs, runtime snapshots, job notices, approvals,
          // compaction checkpoints) are noise in a shell-style history.
          if (typeof sourceKind === 'string' && INJECTED_SOURCE_KINDS.has(sourceKind)) continue;
          const text = textOfNode(node);
          if (text !== '') history.push(text);
        }
        return history;
      }

      /**
       * Collect the Session's typed messages as (seq, text) pairs, oldest first.
       * The live Chat store prunes compacted turns, so pairs are also recorded to
       * localStorage and merged back; that keeps every input recallable.
       * @param nodes - Chat view nodes, in any order.
       * @returns ordered pairs; empty for an unknown shape.
       */
      function pairsFromNodes(nodes) {
        if (!Array.isArray(nodes) || nodes.length === 0) return [];
        const order = (node) => {
          if (node !== null && node !== undefined && typeof node.anchorSeq === 'number') return node.anchorSeq;
          const seq = node === null || node === undefined || node.data === null || node.data === undefined ? undefined : node.data.seq;
          return typeof seq === 'number' ? seq : 0;
        };
        const ordered = [...nodes].sort((left, right) => order(left) - order(right));
        const pairs = [];
        for (const node of ordered) {
          if (node === null || node === undefined || typeof node !== 'object') continue;
          if (node.visibility !== undefined && node.visibility !== 'visible') continue;
          if (!HUMAN_KINDS.has(node.kind)) continue;
          const data = node.data === undefined || node.data === null ? node : node.data;
          const sourceKind = data === null || typeof data !== 'object' ? undefined : data.source?.kind;
          if (typeof sourceKind === 'string' && INJECTED_SOURCE_KINDS.has(sourceKind)) continue;
          const text = textOfNode(node);
          if (text === '') continue;
          pairs.push({ s: order(node), t: text });
        }
        return pairs;
      }

      /** Most recently seen pairs kept per Session; bounded to keep storage small. */
      const HISTORY_CAP = 300;
      const RECORD_PREFIX = 'dsh-composer-input-history:';

      /**
       * Read the pairs recorded for one Session.
       * @param sessionKey - the Session id, when known.
       * @returns recorded pairs; [] when storage is unavailable.
       */
      function loadRecordedPairs(sessionKey) {
        if (typeof sessionKey !== 'string' || sessionKey === '' || typeof localStorage === 'undefined' || localStorage === null) return [];
        try {
          const raw = localStorage.getItem(RECORD_PREFIX + sessionKey);
          if (raw === null || typeof raw !== 'string' || raw === '') return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((pair) => pair !== null && typeof pair === 'object' && typeof pair.s === 'number' && typeof pair.t === 'string');
        } catch {
          return [];
        }
      }

      /**
       * Persist the union of the recorded pairs and the live ones for one Session.
       * @param sessionKey - the Session id, when known.
       * @param pairs - pairs currently visible in the Chat store.
       */
      function saveRecordedPairs(sessionKey, pairs) {
        if (typeof sessionKey !== 'string' || sessionKey === '' || typeof localStorage === 'undefined' || localStorage === null) return;
        if (!Array.isArray(pairs) || pairs.length === 0) return;
        try {
          const bySeq = new Map();
          for (const pair of loadRecordedPairs(sessionKey)) bySeq.set(pair.s, pair.t);
          for (const pair of pairs) {
            if (pair === null || pair === undefined || typeof pair.s !== 'number' || typeof pair.t !== 'string' || pair.t === '') continue;
            bySeq.set(pair.s, pair.t);
          }
          const merged = [...bySeq.entries()].map(([s, t]) => ({ s, t })).sort((left, right) => left.s - right.s).slice(-HISTORY_CAP);
          localStorage.setItem(RECORD_PREFIX + sessionKey, JSON.stringify(merged));
        } catch {
          /* storage full or blocked: the live store still works */
        }
      }

      /**
       * Merge recorded pairs with the live ones, oldest first.
       * @param recorded - persisted pairs.
       * @param pairs - pairs currently visible in the Chat store.
       * @returns recalled texts.
       */
      function mergePairLists(recorded, pairs) {
        const bySeq = new Map();
        for (const pair of Array.isArray(recorded) ? recorded : []) {
          if (pair !== null && typeof pair === 'object' && typeof pair.s === 'number' && typeof pair.t === 'string') bySeq.set(pair.s, pair.t);
        }
        for (const pair of Array.isArray(pairs) ? pairs : []) {
          if (pair !== null && typeof pair === 'object' && typeof pair.s === 'number' && typeof pair.t === 'string') bySeq.set(pair.s, pair.t);
        }
        return [...bySeq.entries()].map(([, text]) => text);
      }

      /**
       * Whitespace-insensitive projection of a draft: paragraph splits and trailing
       * whitespace are exactly what editor projections change.
       * @param text - a draft.
       * @returns the draft without any whitespace.
       */
      function squash(text) {
        return (typeof text === 'string' ? text : '').replace(/\s+/g, '');
      }

      /**
       * Whether a published draft is our own write, or one of its partial commits.
       * Replacing a draft commits paragraph by paragraph, so intermediate states are
       * prefixes of the text we wrote.
       * @param value - the draft the shell just published.
       * @param full - the text we wrote (or the draft we remembered).
       * @returns whether the published draft belongs to this browse session.
       */
      function isOurWrite(value, full) {
        if (typeof full !== 'string' || full.trim() === '') return false;
        const published = squash(value);
        const whole = squash(full);
        return published.length <= whole.length && whole.startsWith(published);
      }

      /**
       * Whether the composer's slash/reference menu is open right now. The menu owns
       * ArrowUp/ArrowDown while it is visible, so the plugin must yield to it.
       * @returns whether a visible listbox menu is mounted.
       */
      function menuOpen() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
        let listbox = null;
        try {
          listbox = document.querySelector('[role="listbox"]');
        } catch {
          return false;
        }
        if (listbox === null || listbox === undefined) return false;
        if (typeof listbox.getClientRects === 'function' && listbox.getClientRects().length === 0) return false;
        return true;
      }

      /**
       * Whether a keydown would modify the draft text.
       * @param gesture - `{ code, key, control, meta }`, as recorded for the key.
       * @returns whether the key edits text rather than moving around.
       */
      function isTextEditing(gesture) {
        if (gesture === null || gesture === undefined) return false;
        if (gesture.control === true || gesture.meta === true) return gesture.code === 'KeyV' || gesture.code === 'KeyX';
        const code = typeof gesture.code === 'string' ? gesture.code : '';
        if (code === 'Backspace' || code === 'Delete' || code === 'Enter' || code === 'NumpadEnter') return true;
        return typeof gesture.key === 'string' && gesture.key.length === 1;
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
       * Find the composer editor root for one keyboard record.
       * @param context - the record's context (`target`), when it has one.
       * @param composedPath - DOM event path from our own listener, when available.
       * @returns the editor root element, or null when the key belongs elsewhere.
       */
      function editorRoot(context, composedPath) {
        // The DOM path is authoritative: a shadow boundary retargets `event.target`,
        // but composedPath still lists the real nodes inside the shadow tree.
        if (Array.isArray(composedPath)) {
          for (const node of composedPath) {
            if (node !== null && node !== undefined && typeof node.matches === 'function' && node.matches(EDITOR_SELECTOR)) return node;
          }
        }
        const target = context === null || context === undefined ? undefined : context.target;
        if (target !== null && target !== undefined && typeof target.closest === 'function') {
          const direct = target.closest(EDITOR_SELECTOR);
          if (direct !== null && direct !== undefined) return direct;
        }
        return null;
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
        /** The last restore this navigator published, for refill detection. */
        let restore = null;
        /** Whether this browse cycle already handed the remembered draft back. */
        let restoredDraft = false;

        return {
          /** @returns whether a recalled message currently owns the draft. */
          isBrowsing() {
            return browsing;
          },
          /** @returns the draft remembered when browsing started. */
          saved() {
            return savedDraft;
          },
          /**
           * Leave browsing unless the draft changed to what this navigator wrote.
           * @param text - the draft now published by the composer.
           */
          notifyDraft(text) {
            if (!browsing) return;
            const next = typeof text === 'string' ? text : '';
            // Our own write, including its partial paragraph commits. An empty
            // intermediate state counts as ours: a deliberate clear is harmless
            // to ignore, because the remembered draft stays recallable.
            if (isOurWrite(next, written)) return;
            // The shell may re-publish the draft we remembered.
            if (isOurWrite(next, savedDraft)) return;
            // A draft that changed without any text-editing keystroke right after
            // our restore is the shell re-seeding a stale stored draft over it; the
            // component re-asserts the restored text, so keep browsing.
            if (restore !== null && lastTextEditAt <= restore.keyAt && Date.now() - restore.at < 400) return;
            browsing = false;
            written = null;
          },
          /**
           * Leave browsing because the user is editing the draft themselves. The
           * edit is the draft now, so nothing needs restoring.
           */
          edited() {
            if (!browsing) return;
            browsing = false;
            written = null;
          },
          /**
           * Resume browsing after the component re-asserted a restore that the
           * shell had clobbered with a stale stored draft.
           * @param text - the restored draft text.
           */
          resume(text) {
            browsing = true;
            written = null;
            restore = { text: typeof text === 'string' ? text : '', at: Date.now(), keyAt: lastTextEditAt };
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
              const current = typeof draft === 'string' ? draft : '';
              // Restarting from a message this navigator recalled must not overwrite
              // the draft the user was writing, or walking forward would land on a
              // recalled message instead of that draft (an empty composer included).
              if (!isOurWrite(current, written) && !isOurWrite(current, savedDraft)) savedDraft = current;
              browsing = true;
              restore = null;
              restoredDraft = false;
              index = history.length - 1;
            } else if (restoredDraft) {
              // The remembered draft was already handed back; ArrowUp starts the
              // ladder again from the newest message.
              restoredDraft = false;
              index = history.length - 1;
            } else if (index > 0) {
              index -= 1;
            }
            written = history[index];
            return { handled: true, text: written };
          },
          /**
           * Step one message newer; past the newest, hand the saved draft back and
           * let one more press discard it, clearing the composer.
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
            if (restoredDraft) {
              // The draft already came back; this press discards it entirely.
              browsing = false;
              written = null;
              restoredDraft = false;
              restore = { text: '', at: Date.now(), keyAt: lastTextEditAt };
              return { handled: true, text: '' };
            }
            browsing = false;
            written = null;
            restore = { text: savedDraft, at: Date.now(), keyAt: lastTextEditAt };
            if (savedDraft !== '') {
              // The draft is back; one more ArrowDown clears the composer.
              restoredDraft = true;
              browsing = true;
            }
            return { handled: true, text: savedDraft };
          },
          /** Drop all browse state, for example when the Session changes. */
          reset() {
            browsing = false;
            index = 0;
            savedDraft = '';
            written = null;
            restore = null;
            restoredDraft = false;
          },
          /**
           * Record a text this navigator just had published, so the refill
           * counter-punch defends the newest publish rather than an older restore.
           * @param text - the text that was just published.
           */
          notePublished(text) {
            restore = { text: typeof text === 'string' ? text : '', at: Date.now(), keyAt: lastTextEditAt };
          },
          /** Internals for diagnostics: what browse mode remembers right now. */
          debug() {
            return { browsing, index, saved: savedDraft, written, restore, restoredDraft };
          },
        };
      }

      /* One navigator per composer editor element: re-rendering the dock entry keeps
         its browse state, and the remembered draft, while a different Session's
         editor gets a fresh one. Compositions without a DOM share one fallback. */
      const NAVIGATORS = new WeakMap();
      let fallbackNavigator = null;
      function navigatorFor(root) {
        if (root === null || root === undefined || typeof root !== 'object') {
          if (fallbackNavigator === null) fallbackNavigator = createHistoryNavigator();
          return fallbackNavigator;
        }
        const existing = NAVIGATORS.get(root);
        if (existing !== undefined) return existing;
        const created = createHistoryNavigator();
        NAVIGATORS.set(root, created);
        return created;
      }
      /** @returns the composer editor element mounted right now, when there is one. */
      function currentEditorRoot() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
        try {
          return document.querySelector(EDITOR_SELECTOR);
        } catch {
          return null;
        }
      }

      /**
       * Read the current Session's id from the activation context's binding source.
       * The whole lookup is guarded: a scoped ctx throws on undeclared services.
       * @returns the Session id, or null when absent.
       */
      function currentSessionKey() {
        try {
          const current = applyContext?.uiSession?.adapter?.current;
          if (current === null || current === undefined) return null;
          const value = typeof current.getSnapshot === 'function' ? current.getSnapshot() : current.value;
          if (value === null || value === undefined || typeof value !== 'object') return null;
          return typeof value.key === 'string' ? value.key : null;
        } catch {
          return null;
        }
      }

      /* Opt-in in-page diagnostics: off by default in the shipped package. While
         developing, flip DEBUG_ENABLED here (or set window.__DSH_INPUT_HISTORY_DEBUG
         before the bundle loads) to render a status badge and expose
         window.__dshInputHistory with the latest arbitration reason. */
      const DEBUG_ENABLED = false;
      const DEBUG = DEBUG_ENABLED || (typeof window !== 'undefined' && window.__DSH_INPUT_HISTORY_DEBUG === true);
      const debugState = { mounted: 0, observer: 'none', keydowns: 0, domKeydowns: 0, arrows: 0, recalled: 0, saved: 0, path: 'none', last: 'start' };
      let debugBadge = null;
      /** A fixed badge on the page: proves the bundle activated even if no dock entry mounts. */
      function ensureDebugBadge() {
        if (!DEBUG || typeof document === 'undefined') return;
        if (debugBadge !== null && debugBadge.isConnected) return;
        const host = document.body ?? document.documentElement;
        if (host === null || host === undefined) return;
        debugBadge = document.createElement('div');
        debugBadge.setAttribute('data-dsh-input-history-debug', '1');
        debugBadge.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;background:#c8102e;color:#fff;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 7px;border-radius:4px;pointer-events:none;white-space:nowrap;';
        host.appendChild(debugBadge);
      }
      const debugLog = [];
      let lastReport = 0;
      let lastReportedMount = -1;
      /** Short prefix for diagnostics; keeps message bodies out of the report. */
      function prefixOf(value) {
        if (typeof value !== 'string') return value === null || value === undefined ? '(none)' : '(?)';
        return value.slice(0, 8);
      }
      let nodeCensus = [];
      let historyFingerprint = [];
      /** Ship the diagnostic trail to a local collector, so a developer can read it. */
      function reportDebug() {
        if (!DEBUG || typeof fetch !== 'function') return;
        const now = Date.now();
        // Throttle keystrokes, but never swallow a mount transition.
        if (debugState.mounted === lastReportedMount && now - lastReport < 400) return;
        lastReport = now;
        lastReportedMount = debugState.mounted;
        const payload = {
          time: now,
          state: { ...debugState },
          census: nodeCensus,
          history: historyFingerprint,
          log: debugLog.slice(-40),
        };
        try {
          fetch('http://127.0.0.1:19399/ih', {
            method: 'POST',
            mode: 'no-cors',
            keepalive: true,
            body: JSON.stringify(payload),
          }).catch(() => {});
        } catch {
          /* CSP or a fetch failure: the badge still works */
        }
      }
      function paintDebug() {
        if (!DEBUG) return;
        ensureDebugBadge();
        if (typeof window !== 'undefined') window.__dshInputHistory = { ...debugState };
        const text = 'IH m=' + debugState.mounted + ' obs=' + debugState.observer + ' dom=' + debugState.domKeydowns + ' k=' + debugState.keydowns + ' a=' + debugState.arrows + ' r=' + debugState.recalled + ' sv=' + debugState.saved + ' path=' + debugState.path + ' last=' + debugState.last;
        if (debugBadge !== null) debugBadge.textContent = text;
        reportDebug();
      }
      function noteDebug(reason) {
        if (!DEBUG) return;
        debugState.last = reason;
        debugLog.push({
          t: Date.now(),
          reason,
          path: debugState.path,
          a: debugState.arrows,
          r: debugState.recalled,
          m: debugState.mounted,
          sv: debugState.saved,
          dom: debugState.domKeydowns,
          k: debugState.keydowns,
        });
        if (debugLog.length > 40) debugLog.shift();
        // Handling decisions are rare and decisive; never let the throttle eat them.
        if (/^(handled:|refused:|browse-exit|refill-counter|page-error)/.test(reason)) lastReport = 0;
        paintDebug();
      }

      /**
       * Arbitrate one fixed-input record.
       * @param event - `{ type, gesture, context, consume }` from the shortcuts service.
       * @param refs - live navigator, history, input state, and input actions.
       */
      function handleKey(event, refs, path = 'fixed') {
        if (event === null || event === undefined || event.type !== 'keydown') { noteDebug('non-keydown'); return; }
        lastKeydownAt = Date.now();
        if (path === 'dom') debugState.domKeydowns += 1;
        else debugState.keydowns += 1;
        const gesture = event.gesture;
        const context = event.context;
        if (gesture === undefined || gesture === null || context === undefined || context === null) { noteDebug('bad-record'); return; }
        if (isTextEditing(gesture)) lastTextEditAt = Date.now();
        // An IME owns the key while it composes.
        if (gesture.composing) { noteDebug('composing'); return; }
        const menuIsOpen = typeof refs.isMenuOpen === 'function' ? refs.isMenuOpen() : false;
        if (path === 'dom') {
          // This listener runs in the capture phase, before the composer's own keymap
          // and before Lexical can swallow the key while moving the caret. Only a
          // visible slash/reference menu still wins.
          if (menuIsOpen) { noteDebug('menu-open'); return; }
        } else if (gesture.defaultPrevented) {
          // The fixed-input feed runs after local controls, so a handled key is
          // already accounted for: an open menu, or this plugin's own DOM path.
          noteDebug('handled-upstream'); return;
        }
        // Editing the draft by hand ends browse mode at once; the edit is the draft.
        if (refs.nav.isBrowsing() && isTextEditing(gesture)) { refs.nav.edited(); noteDebug('edited:' + gesture.code); return; }
        if (gesture.control || gesture.alt || gesture.meta || gesture.shift) { noteDebug('modifier'); return; }
        if (gesture.code !== 'ArrowUp' && gesture.code !== 'ArrowDown') { noteDebug('other-key:' + gesture.code); return; }
        debugState.arrows += 1;
        debugState.path = path;
        const root = editorRoot(context, event.composedPath);
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
        if (typeof result.text === 'string' && result.text !== draft) {
          // Register the publish before it lands: the draft effect that runs
          // during setDraft must already defend this text, not an older one.
          if (typeof nav.notePublished === 'function') nav.notePublished(result.text);
          actions.setDraft(result.text);
        }
        noteDebug('handled:' + gesture.code);
      }

      /**
       * Invisible Session-scoped occupant: it owns this Session's browse state and
       * the keyboard observer, and renders nothing.
       * @param props - standard Session props (`useChat`, `useInput`, `inputActions`).
       * @returns null.
       */
      function InputHistory(props) {
        if (DEBUG) {
          debugState.renders = (debugState.renders ?? 0) + 1;
          if (debugState.renders === 1) {
            debugState.firstProps = Object.keys(props ?? {}).join(',');
            debugState.firstRenderStack = new Error().stack?.split('\n').filter((line) => !line.includes('InputHistory')).slice(0, 4).join(' | ').slice(0, 600) ?? '(no stack)';
          }
        }
        // The Session standard kit always supplies both hooks; stay inert rather
        // than crash the dock entry if another composition omits one.
        const useChatHook = typeof props.useChat === 'function' ? props.useChat : null;
        const useInputHook = typeof props.useInput === 'function' ? props.useInput : null;
        const nodes = useChatHook === null ? undefined : useChatHook((snapshot) => (snapshot === null || snapshot === undefined ? undefined : nodesFromStore(snapshot.nodes)));
        const input = useInputHook === null ? undefined : useInputHook((state) => state);

        const navRef = React.useRef(null);
        if (navRef.current === null) navRef.current = navigatorFor(currentEditorRoot());
        const nav = navRef.current;

        const history = React.useMemo(() => historyFromNodes(nodes), [nodes]);

        // The live store prunes compacted turns, so every typed message is also
        // recorded per Session and merged back into the recallable history.
        const pairs = React.useMemo(() => pairsFromNodes(nodes), [nodes]);
        const sessionKeyRef = React.useRef(null);
        const sessionKey = currentSessionKey();
        if (typeof sessionKey === 'string' && sessionKey !== '') sessionKeyRef.current = sessionKey;
        const mergedHistory = React.useMemo(() => {
          const recorded = loadRecordedPairs(typeof sessionKey === 'string' ? sessionKey : sessionKeyRef.current);
          if (recorded.length === 0) return history;
          return mergePairLists(recorded, pairs);
        }, [history, pairs, sessionKey]);
        React.useEffect(() => {
          saveRecordedPairs(typeof sessionKey === 'string' ? sessionKey : sessionKeyRef.current, pairs);
        }, [pairs, sessionKey]);

        const historyRef = React.useRef(mergedHistory);
        historyRef.current = mergedHistory;

        const inputRef = React.useRef(input);
        inputRef.current = input;

        const actionsRef = React.useRef(props.inputActions);
        actionsRef.current = props.inputActions;

        // Typing, a command, or a send leaves browse mode at once.
        React.useEffect(() => {
          const draft = input !== null && input !== undefined && typeof input.draft === 'string' ? input.draft : '';
          const wasBrowsing = nav.isBrowsing();
          nav.notifyDraft(draft);
          debugState.saved = nav.saved().length;
          debugState.draftLen = draft.length;
          debugState.draft = prefixOf(draft);
          if (wasBrowsing && !nav.isBrowsing()) {
            const memory = typeof nav.debug === 'function' ? nav.debug() : null;
            noteDebug(
              'browse-exit draft=' + JSON.stringify(prefixOf(draft)) + '(' + draft.length + ')'
              + ' written=' + (memory === null ? '?' : JSON.stringify(prefixOf(memory.written)))
              + ' saved=' + (memory === null ? '?' : JSON.stringify(prefixOf(memory.saved))),
            );
          }
          // Counter-punch: when the shell re-seeds a stale stored draft over a fresh
          // restore (no keystroke involved), put the restored text back.
          const memory = typeof nav.debug === 'function' ? nav.debug() : null;
          const pendingRestore = memory === null ? null : memory.restore;
          if (
            pendingRestore !== null && pendingRestore !== undefined && typeof pendingRestore.text === 'string'
            && draft !== pendingRestore.text && Date.now() - pendingRestore.at < 400 && lastTextEditAt <= pendingRestore.keyAt
          ) {
            const actions = actionsRef.current;
            if (actions !== undefined && actions !== null && typeof actions.setDraft === 'function') {
              noteDebug('refill-counter ' + JSON.stringify(prefixOf(draft)) + ' -> ' + JSON.stringify(prefixOf(pendingRestore.text)));
              actions.setDraft(pendingRestore.text);
              if (typeof nav.resume === 'function') nav.resume(pendingRestore.text);
            }
          }
          paintDebug();
        }, [nav, input]);

        // Diagnostics: what the Chat store actually holds and what the reader kept.
        React.useEffect(() => {
          if (!DEBUG) return;
          nodeCensus = Array.isArray(nodes)
            ? nodes.slice(0, 16).map((node) => {
                const data = node === null || node === undefined || typeof node !== 'object' ? {} : node.data ?? {};
                return {
                  k: node?.kind,
                  v: node?.visibility,
                  s: typeof data?.source?.kind === 'string' ? data.source.kind : typeof data?.source === 'string' ? data.source : undefined,
                  a: node?.anchorSeq ?? data?.seq,
                  len: textOfNode(node).length,
                  p: prefixOf(textOfNode(node)),
                };
              })
            : [{ bad: 'nodes not an array' }];
          historyFingerprint = Array.isArray(mergedHistory) ? mergedHistory.map((text) => ({ len: text.length, p: prefixOf(text) })) : [];
          debugState.recorded = loadRecordedPairs(typeof sessionKey === 'string' ? sessionKey : sessionKeyRef.current).length;
          debugState.session = typeof sessionKey === 'string' ? sessionKey.slice(0, 8) : '(none)';
          paintDebug();
        }, [nodes, mergedHistory, sessionKey]);

        // Two keyboard paths on purpose: the activation-time feed in apply() owns
        // the document listener so it survives dock remounts; this effect only
        // publishes this Session's refs to it.
        React.useEffect(() => {
          debugState.mounted += 1;
          debugState.effectRuns = (debugState.effectRuns ?? 0) + 1;
          const refs = { nav, historyRef, inputRef, actionsRef, isMenuOpen: menuOpen };
          activeRefs = refs;
          debugState.observer = 'installed';
          paintDebug();

          return () => {
            if (activeRefs === refs) activeRefs = null;
            debugState.mounted -= 1;
            paintDebug();
          };
        }, [nav]);

        return null;
      }

      return {
        inject: ['slots', 'shortcuts', 'uiSession'],
        apply(ctx) {
          applyContext = ctx;
          // Diagnostic badge first: it appears the moment the bundle activates.
          if (DEBUG) {
            ensureDebugBadge();
            paintDebug();
          }

          // Activation-time keyboard feed: installed once, independent of the dock
          // entry mounting, so a remount or hot reload never silences the plugin.
          // It serves whichever dock entry is currently mounted (there is one
          // resident composer per page) and reports no-binding while none is.
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('keydown', (domEvent) => {
              if (activeRefs === null) {
                noteDebug('no-binding:' + domEvent.code);
                return;
              }
              handleKey({
                type: 'keydown',
                gesture: {
                  code: domEvent.code,
                  key: domEvent.key,
                  control: domEvent.ctrlKey,
                  alt: domEvent.altKey,
                  meta: domEvent.metaKey,
                  shift: domEvent.shiftKey,
                  repeat: domEvent.repeat,
                  composing: domEvent.isComposing === true,
                  defaultPrevented: domEvent.defaultPrevented,
                },
                context: { region: 'editable', target: domEvent.target },
                composedPath: typeof domEvent.composedPath === 'function' ? domEvent.composedPath() : undefined,
                consume: () => domEvent.preventDefault(),
              }, activeRefs, 'dom');
            }, true);
            debugState.observer = 'installed';
            paintDebug();
          } else if (DEBUG) {
            debugState.observer = 'no-dom';
            paintDebug();
          }
          const shortcuts = ctx.shortcuts;
          if (shortcuts !== undefined && shortcuts !== null && typeof shortcuts.observeFixedInput === 'function') {
            shortcuts.observeFixedInput((event) => {
              if (activeRefs === null) {
                noteDebug('no-binding:' + (event?.gesture?.code ?? 'key'));
                return;
              }
              handleKey(event, activeRefs, 'fixed');
            });
            debugState.observer = 'installed';
          }
          // Surface any page error (e.g. a dock render crash) in the diagnostics.
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('error', (event) => {
              noteDebug('page-error: ' + (event && typeof event.message === 'string' ? event.message.slice(0, 80) : 'unknown'));
            });
          }

          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'input-history',
            order: 20,
          }, InputHistory));
        },
        /** Pure helpers, exposed for the package's own tests. */
        __test: { textOfNode, nodesFromStore, historyFromNodes, pairsFromNodes, mergePairLists, createHistoryNavigator, navigatorFor, canStartRecall, editorRoot, isOurWrite, isTextEditing, handleKey },
      };
    },
  });
})();
