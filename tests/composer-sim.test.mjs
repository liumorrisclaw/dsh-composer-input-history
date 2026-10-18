// Simulated-composer integration test.
//
// Mounts the real InputHistory component against stub React, DOM, and
// localStorage hosts, then replays the shell behaviour observed in the running
// app: whole-draft publishes, a stale stored-draft refill after a clear
// (DefaultConversationViews re-seeding), and compaction pruning of the Chat
// store. Runs in plain Node via `node --test`; no browser involved.

import test from 'node:test';
import assert from 'node:assert/strict';

const EDITOR_SELECTOR = '[data-lexical-editor="true"]';

let definition = null;
globalThis.window = {
  __ModuleLoader__: { load(loaded) { definition = loaded; } },
  // The shipped package ships diagnostics off; the sim asserts on them through
  // the documented runtime escape hatch.
  __DSH_INPUT_HISTORY_DEBUG: true,
};
await import(new URL('../client.js', import.meta.url).href);

function depsMatch(previous, next) {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return false;
  }
  return true;
}

/** Minimal React stub: call-order hook slots with manually flushed effects. */
function createReactStub() {
  let index = 0;
  const refs = [];
  const memos = [];
  const effects = [];
  return {
    React: {
      useRef(initial) {
        const id = index;
        index += 1;
        if (refs[id] === undefined) refs[id] = { current: initial };
        return refs[id];
      },
      useMemo(factory, deps) {
        const id = index;
        index += 1;
        const slot = memos[id];
        if (slot !== undefined && depsMatch(slot.deps, deps)) return slot.value;
        const value = factory();
        memos[id] = { deps, value };
        return value;
      },
      useEffect(effect, deps) {
        const id = index;
        index += 1;
        const slot = effects[id] ?? (effects[id] = { ran: false, cleanup: undefined, prevDeps: undefined });
        slot.effect = effect;
        slot.deps = deps;
      },
    },
    beginRender() {
      index = 0;
    },
    debugEffects() {
      return effects.map((slot) => (slot === undefined ? null : { ran: slot.ran, deps: slot.deps === undefined ? null : slot.deps.length }));
    },
    flushEffects() {
      for (let id = 0; id < effects.length; id += 1) {
        const slot = effects[id];
        if (slot === undefined) continue;
        if (!slot.ran || !depsMatch(slot.prevDeps, slot.deps)) {
          try {
            if (slot.ran) console.error('[sim] effect', id, 're-ran');
            if (typeof slot.cleanup === 'function') slot.cleanup();
            slot.cleanup = slot.effect();
          } catch (error) {
            console.error('[sim] effect', id, 'threw:', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error);
            throw error;
          }
          slot.prevDeps = slot.deps;
          slot.ran = true;
        }
      }
    },
  };
}

/** Stub document/window/localStorage sufficient for the component's seams. */
function createHost() {
  const storage = new Map();
  const captureListeners = [];
  let listbox = null;
  const editorEl = {
    matches: (selector) => selector === EDITOR_SELECTOR,
    closest: (selector) => (selector === EDITOR_SELECTOR ? editorEl : null),
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }),
  };
  const documentStub = {
    body: { appendChild() {} },
    createElement: () => ({ style: { cssText: '' }, setAttribute() {}, appendChild() {}, isConnected: true, textContent: '' }),
    addEventListener(type, listener) {
      if (type === 'keydown') captureListeners.push(listener);
    },
    removeEventListener(type, listener) {
      const at = captureListeners.indexOf(listener);
      if (at >= 0) captureListeners.splice(at, 1);
    },
    querySelector(selector) {
      return selector === '[role="listbox"]' ? listbox : null;
    },
  };
  return {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    editorEl,
    captureListeners,
    documentStub,
    openMenu() {
      listbox = { getClientRects: () => [{ top: 0 }] };
    },
    closeMenu() {
      listbox = null;
    },
    keydown(overrides = {}) {
      const event = {
        code: 'ArrowUp',
        key: 'ArrowUp',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        prevented: false,
        target: editorEl,
        composedPath: () => [editorEl],
        preventDefault() {
          event.prevented = true;
          event.defaultPrevented = true;
        },
        ...overrides,
      };
      for (const listener of [...captureListeners]) listener(event);
      return event;
    },
  };
}

/** The composer shell: publishes drafts and mirrors them one tick late. */
function createShell({ react, component }) {
  const shell = {
    draft: '',
    storedDraft: '',
    nodes: [],
    writes: [],
    inputState: { draft: '', phase: 'plain' },
    publish(text) {
      shell.draft = text;
      shell.inputState = { ...shell.inputState, draft: text };
      shell.render();
    },
    render() {
      react.beginRender();
      component({
        useChat: (selector) => selector(shell.chatSnapshot),
        useInput: (selector) => selector(shell.inputState),
        inputActions: shell.inputActions,
      });
      react.flushEffects();
    },
  };
  shell.chatSnapshot = { nodes: { values: () => shell.nodes } };
  shell.inputActions = {
    setDraft(text) {
      shell.writes.push(text);
      shell.publish(text);
    },
  };
  return shell;
}

/** Load the bundle, register the dock entry, and mount it once. */
function mountPlugin({ nodes, sessionKey = 'session-1' }) {
  const react = createReactStub();
  const host = createHost();
  globalThis.fetch = undefined; // keep diagnostics quiet
  globalThis.document = host.documentStub;
  Object.assign(globalThis.window, {
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) }),
    }),
    getComputedStyle: () => ({ lineHeight: '20px' }),
  });
  globalThis.localStorage = host.localStorage;

  const plugin = definition.factory((name) => (name === 'react' ? react.React : undefined));

  let registered = null;
  let fixedHandler = null;
  let fixedObserved = 0;
  const ctx = {
    slots: {
      inject(name, factory) {
        factory();
      },
      register(descriptor, component) {
        registered = component;
        return { descriptor, component };
      },
    },
    shortcuts: {
      observeFixedInput(handler) {
        fixedHandler = handler;
        fixedObserved += 1;
        return () => {};
      },
    },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: sessionKey }) } } },
  };
  plugin.apply(ctx);

  const shell = createShell({ react, component: registered });
  shell.nodes = nodes;
  shell.render();
  console.log('[sim] effects after mount:', JSON.stringify(react.debugEffects()));
  return { react, host, shell, fixedHandler, fixedObserved: () => fixedObserved };
}

function nodeFor(seq, text) {
  return { key: `k${seq}`, kind: 'user', visibility: 'visible', anchorSeq: seq, data: { seq, content: [{ type: 'text', text }] } };
}

const MSG_OLD = '第一条测试消息';
const MSG_NEW = '第二条测试消息';

test('the ladder reaches the blank draft even when the shell refills a stale draft', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's1' });
  const { host, shell, fixedObserved } = mounted;

  // The activation context wired the fixed-input feed (the ctx-scope fix).
  assert.ok(fixedObserved() >= 1);

  // Empty draft: ArrowUp recalls the newest message.
  const first = host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  console.log('[sim] arbitration:', JSON.stringify(globalThis.window.__dshInputHistory));
  console.log('[sim] listeners:', host.captureListeners.length, '| draft:', JSON.stringify(shell.draft));
  console.log('[sim] effects after mount:', JSON.stringify(mounted.react.debugEffects()));
  assert.equal(first.prevented, true, 'handled keys are claimed');
  assert.equal(shell.draft, MSG_NEW);

  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  console.log('[dbg] after 2nd up:', JSON.stringify(globalThis.window.__dshInputHistory));
  assert.equal(shell.draft, MSG_OLD);
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, MSG_NEW);

  // Past the newest: restore the remembered (blank) draft.
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, '');

  // The host re-seeds a stale stored draft over the clear, without a keystroke.
  shell.storedDraft = '过期草稿';
  shell.inputActions.setDraft('过期草稿');
  assert.equal(shell.draft, '', 'the counter-punch re-asserts the restored blank');
  assert.equal(shell.writes.at(-1), '');

  // Browse mode survived the refill: the next ArrowDown is handled again (the
  // draft is already blank, so the restore is a no-op write).
  shell.writes.length = 0;
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, '');
  assert.equal(globalThis.window.__dshInputHistory.last, 'handled:ArrowDown');
});

test('a typed draft survives walking down past the newest, and re-entering browse', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's2' });
  const { host, shell } = mounted;

  shell.publish('我的草稿');
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, '我的草稿');

  // Re-entering browse from the restored draft must not clobber the memory.
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  shell.writes.length = 0;
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.deepEqual(shell.writes, ['我的草稿']);
  assert.equal(shell.draft, '我的草稿');
});

test('recorded pairs survive a compaction prune of the Chat store', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's3' });
  const { host, shell } = mounted;

  // The store drops the old node after a compaction; the record keeps it.
  shell.nodes = [nodeFor(2, MSG_NEW)];
  shell.render();
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  shell.writes.length = 0;
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_OLD, 'the pruned message is still recallable from the record');
});

test('a manual edit ends browse mode and the next browse remembers the edit', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's4' });
  const { host, shell } = mounted;

  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);

  // Editing by hand ends browse mode; the edit becomes the draft.
  host.keydown({ code: 'Backspace', key: 'Backspace' });
  shell.publish(MSG_NEW.slice(0, -1));

  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  shell.writes.length = 0;
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.deepEqual(shell.writes, [MSG_NEW.slice(0, -1)]);
  assert.equal(shell.draft, MSG_NEW.slice(0, -1));
});

test('an open menu keeps the key, and the fixed path defers to the DOM path', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's5' });
  const { host, shell, fixedHandler } = mounted;

  host.openMenu();
  const menuEvent = host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(menuEvent.prevented, false, 'the visible menu owns the key');
  host.closeMenu();

  // The DOM path handles the key; a later fixed record must not double-step.
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  const fixedRecord = {
    type: 'keydown',
    gesture: { code: 'ArrowUp', key: 'ArrowUp', control: false, alt: false, meta: false, shift: false, repeat: false, composing: false, defaultPrevented: true },
    context: { region: 'editable', target: host.editorEl },
    consumed: false,
    consume() {
      this.consumed = true;
    },
  };
  fixedHandler(fixedRecord);
  assert.equal(fixedRecord.consumed, false, 'already handled upstream');
  assert.equal(shell.draft, MSG_NEW);
});

test('one more ArrowDown after the draft discards it entirely', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD), nodeFor(2, MSG_NEW)], sessionKey: 's7' });
  const { host, shell } = mounted;
  shell.publish('我的草稿');
  host.keydown({ code: 'ArrowUp', key: 'ArrowUp' });
  assert.equal(shell.draft, MSG_NEW);
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, '我的草稿');
  host.keydown({ code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(shell.draft, '', 'the final press clears the composer');
});

test('an IME composition and foreign targets never recall', () => {
  const mounted = mountPlugin({ nodes: [nodeFor(1, MSG_OLD)], sessionKey: 's6' });
  const { host, shell } = mounted;

  const composing = host.keydown({ code: 'ArrowUp', key: 'ArrowUp', isComposing: true });
  assert.equal(composing.prevented, false);
  assert.equal(shell.draft, '');

  const elsewhere = host.keydown({
    code: 'ArrowUp',
    key: 'ArrowUp',
    target: { closest: () => null },
    composedPath: () => [{ matches: () => false }],
  });
  assert.equal(elsewhere.prevented, false);
  assert.equal(shell.draft, '');
});
