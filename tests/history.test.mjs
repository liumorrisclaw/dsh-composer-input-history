// Unit tests for the pure half of the input-history client bundle.
//
// The browser bundle is a classic script that registers a lazy factory; the
// tests load it against a stub module-loader, then exercise the exported pure
// helpers. No DOM, React, or harness runtime is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

await import(pathToFileURL(join(packageRoot, 'client.js')).href);
assert.ok(loaded !== null, 'client.js must register a bundle through __ModuleLoader__.load');

const plugin = loaded.factory((id) => (id === 'react' ? {} : {}));
const { textOfNode, nodesFromStore, historyFromNodes, createHistoryNavigator, canStartRecall, handleKey } = plugin.__test;

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8');

test('the bundle registers the package name', () => {
  assert.equal(loaded.id, manifest.name);
  assert.match(patch, new RegExp(`name: '${manifest.name.replace('/', '\\/')}'`));
});

test('the plugin injects the services it uses and registers one dock entry', () => {
  assert.deepEqual([...plugin.inject].sort(), ['shortcuts', 'slots']);
  const registered = [];
  plugin.apply({
    slots: {
      inject(_owner, install) {
        install();
      },
      register(spec, component) {
        registered.push({ spec, component });
      },
    },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].spec.name, 'conversation.composer.dock');
  assert.equal(registered[0].spec.id, 'input-history');
  assert.equal(typeof registered[0].component, 'function');
});

test('textOfNode reads text blocks only', () => {
  assert.equal(textOfNode({ data: { content: [{ type: 'text', text: 'hello' }] } }), 'hello');
  assert.equal(textOfNode({ data: { content: [{ type: 'text', text: 'a' }, { type: 'image', attachmentId: 'x' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  assert.equal(textOfNode({ data: { content: [{ type: 'image', attachmentId: 'x' }] } }), '');
  assert.equal(textOfNode({ data: {} }), '');
  assert.equal(textOfNode(null), '');
});

test('historyFromNodes keeps human texts in order and skips everything else', () => {
  const nodes = [
    { kind: 'system-prompt', visibility: 'visible', data: { content: [{ type: 'text', text: 'prompt' }] } },
    { kind: 'user', visibility: 'visible', data: { content: [{ type: 'text', text: 'first' }] } },
    { kind: 'assistant', visibility: 'visible', data: { content: [{ type: 'text', text: 'reply' }] } },
    { kind: 'steering', visibility: 'visible', data: { content: [{ type: 'text', text: 'steer' }] } },
    { kind: 'user', visibility: 'invisible', data: { content: [{ type: 'text', text: 'hidden' }] } },
    { kind: 'user', visibility: 'visible', data: { content: [{ type: 'image', attachmentId: 'x' }] } },
    { kind: 'turn-trigger', visibility: 'visible', data: { content: [{ type: 'text', text: 'wake' }] } },
  ];
  assert.deepEqual(historyFromNodes(nodes), ['first', 'steer', 'wake']);
  assert.deepEqual(historyFromNodes(undefined), []);
  assert.deepEqual(historyFromNodes([]), []);
});

test('canStartRecall allows empty and single-line drafts, and first-line carets', () => {
  assert.equal(canStartRecall('', false), true);
  assert.equal(canStartRecall('   \n  ', false), true);
  assert.equal(canStartRecall('one line', false), true);
  assert.equal(canStartRecall('two\nlines', false), false);
  assert.equal(canStartRecall('two\nlines', true), true);
});

test('ArrowUp browses backwards from the newest message', () => {
  const nav = createHistoryNavigator();
  const history = ['one', 'two', 'three'];

  assert.deepEqual(nav.up({ history, draft: '', caretOnFirstLine: false }), { handled: true, text: 'three' });
  nav.notifyDraft('three');
  assert.deepEqual(nav.up({ history, draft: 'three', caretOnFirstLine: false }), { handled: true, text: 'two' });
  nav.notifyDraft('two');
  assert.deepEqual(nav.up({ history, draft: 'two', caretOnFirstLine: false }), { handled: true, text: 'one' });
  nav.notifyDraft('one');
  assert.deepEqual(nav.up({ history, draft: 'one', caretOnFirstLine: false }), { handled: true, text: 'one' });
});

test('ArrowDown walks forward and finally restores the saved draft', () => {
  const nav = createHistoryNavigator();
  const history = ['one', 'two'];

  // Start browsing from a draft that is not empty.
  assert.deepEqual(nav.up({ history, draft: 'draft in progress', caretOnFirstLine: false }), { handled: true, text: 'two' });
  nav.notifyDraft('two');
  // One message older, then back down through the newest message.
  assert.deepEqual(nav.up({ history, draft: 'two', caretOnFirstLine: false }), { handled: true, text: 'one' });
  nav.notifyDraft('one');
  assert.deepEqual(nav.down({ history }), { handled: true, text: 'two' });
  nav.notifyDraft('two');
  // Past the newest, the draft written before browsing comes back.
  assert.deepEqual(nav.down({ history }), { handled: true, text: 'draft in progress' });
  assert.equal(nav.isBrowsing(), false);
  assert.deepEqual(nav.down({ history }), { handled: false });
});

test('a multiline draft only browses from the first line', () => {
  const nav = createHistoryNavigator();
  const history = ['one'];
  assert.deepEqual(nav.up({ history, draft: 'a\nb', caretOnFirstLine: false }), { handled: false });
  assert.equal(nav.isBrowsing(), false);
  assert.deepEqual(nav.up({ history, draft: 'a\nb', caretOnFirstLine: true }), { handled: true, text: 'one' });
});

test('an empty history never takes the key', () => {
  const nav = createHistoryNavigator();
  assert.deepEqual(nav.up({ history: [], draft: '', caretOnFirstLine: false }), { handled: false });
  assert.deepEqual(nav.up({ history: undefined, draft: '', caretOnFirstLine: false }), { handled: false });
  assert.deepEqual(nav.down({ history: [] }), { handled: false });
});

test('editing the recalled draft leaves browse mode', () => {
  const nav = createHistoryNavigator();
  const history = ['one', 'two'];
  nav.up({ history, draft: '', caretOnFirstLine: false });
  nav.notifyDraft('two');            // our own write keeps browsing
  assert.equal(nav.isBrowsing(), true);
  nav.notifyDraft('two edited');     // a human/other writer leaves it
  assert.equal(nav.isBrowsing(), false);
  assert.deepEqual(nav.up({ history, draft: 'two edited', caretOnFirstLine: false }), { handled: true, text: 'two' });
});

test('a locked composer phase refuses draft writes', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const event = keyEvent('ArrowUp');
  handleKey(event, {
    nav,
    historyRef: { current: ['one'] },
    inputRef: { current: { draft: '', phase: 'submitting' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(event.consumed, 0);
  assert.deepEqual(calls, []);
});

test('ArrowUp in the composer editor is consumed and recalls the newest message', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const event = keyEvent('ArrowUp');
  handleKey(event, {
    nav,
    historyRef: { current: ['one', 'two'] },
    inputRef: { current: { draft: '', phase: 'plain' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(event.consumed, 1);
  assert.deepEqual(calls, ['two']);
});

test('ArrowDown without browse state is left to the editor', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const event = keyEvent('ArrowDown');
  handleKey(event, {
    nav,
    historyRef: { current: ['one'] },
    inputRef: { current: { draft: '', phase: 'plain' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(event.consumed, 0);
  assert.deepEqual(calls, []);
});

test('keys already consumed by the composer or menu are left alone', () => {
  const nav = createHistoryNavigator();
  for (const overrides of [
    { defaultPrevented: true },
    { composing: true },
    { control: true },
    { shift: true },
  ]) {
    const calls = [];
    const event = keyEvent('ArrowUp', overrides);
    handleKey(event, {
      nav,
      historyRef: { current: ['one'] },
      inputRef: { current: { draft: '', phase: 'plain' } },
      actionsRef: { current: { setDraft: (text) => calls.push(text) } },
    });
    assert.equal(event.consumed, 0, JSON.stringify(overrides));
    assert.deepEqual(calls, []);
  }
});

test('keys outside the composer editor are left alone', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const event = keyEvent('ArrowUp');
  event.context.target = { closest: () => null };
  handleKey(event, {
    nav,
    historyRef: { current: ['one'] },
    inputRef: { current: { draft: '', phase: 'plain' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(event.consumed, 0);
  assert.deepEqual(calls, []);
});

test('non-keydown and malformed records are ignored', () => {
  const nav = createHistoryNavigator();
  const refs = { nav, historyRef: { current: ['one'] }, inputRef: { current: { draft: '', phase: 'plain' } }, actionsRef: { current: { setDraft() {} } } };
  assert.equal(handleKey({ type: 'reset' }, refs), undefined);
  assert.equal(handleKey(null, refs), undefined);
  assert.equal(handleKey({ type: 'keydown', gesture: null, context: null }, refs), undefined);
});

test('whitespace-only and malformed content never enters the history', () => {
  const nodes = [
    { kind: 'user', visibility: 'visible', data: { content: [{ type: 'text', text: '   \n  ' }] } },
    { kind: 'user', visibility: 'visible', data: { content: { type: 'text', text: 'not a list' } } },
    { kind: 'user', visibility: 'visible', data: { content: [{ type: 'text', text: 'real' }, null] } },
  ];
  assert.deepEqual(historyFromNodes(nodes), ['real']);
});

test('repeated identical messages are kept in order, like a shell history', () => {
  const nodes = ['same', 'same', 'other'].map((text) => ({
    kind: 'user',
    visibility: 'visible',
    data: { content: [{ type: 'text', text }] },
  }));
  assert.deepEqual(historyFromNodes(nodes), ['same', 'same', 'other']);
});

test('resetting the navigator drops browse state', () => {
  const nav = createHistoryNavigator();
  const history = ['one', 'two'];
  nav.up({ history, draft: '', caretOnFirstLine: false });
  assert.equal(nav.isBrowsing(), true);
  nav.reset();
  assert.equal(nav.isBrowsing(), false);
  // Browsing restarts from the newest message and forgets the abandoned draft.
  assert.deepEqual(nav.up({ history, draft: '', caretOnFirstLine: false }), { handled: true, text: 'two' });
});

test('a held ArrowUp keeps stepping back through the history', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const history = ['oldest', 'middle', 'newest'];
  const refs = {
    nav,
    historyRef: { current: history },
    inputRef: { current: { draft: '', phase: 'plain' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  };
  const first = keyEvent('ArrowUp', { repeat: true });
  handleKey(first, refs);
  refs.inputRef.current = { draft: 'newest', phase: 'plain' };
  nav.notifyDraft('newest');
  const second = keyEvent('ArrowUp', { repeat: true });
  handleKey(second, refs);
  assert.equal(first.consumed, 1);
  assert.equal(second.consumed, 1);
  assert.deepEqual(calls, ['newest', 'middle']);
});

test('an adjudicating composer phase refuses draft writes', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const event = keyEvent('ArrowUp');
  handleKey(event, {
    nav,
    historyRef: { current: ['one'] },
    inputRef: { current: { draft: '', phase: 'adjudicating' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(event.consumed, 0);
  assert.deepEqual(calls, []);
});

test('other keys and a missing input state are ignored', () => {
  const nav = createHistoryNavigator();
  const calls = [];
  const letter = keyEvent('KeyH');
  handleKey(letter, {
    nav,
    historyRef: { current: ['one'] },
    inputRef: { current: { draft: '', phase: 'plain' } },
    actionsRef: { current: { setDraft: (text) => calls.push(text) } },
  });
  assert.equal(letter.consumed, 0);

  const missingState = keyEvent('ArrowUp');
  handleKey(missingState, { nav, historyRef: { current: ['one'] }, inputRef: { current: undefined }, actionsRef: { current: { setDraft() {} } } });
  assert.equal(missingState.consumed, 0);
  assert.deepEqual(calls, []);
});

test('a non-string draft is treated as empty', () => {
  assert.equal(canStartRecall(undefined, false), true);
  assert.equal(canStartRecall(null, false), true);
});

test('nodesFromStore reads the Chat node store facade', () => {
  const nodes = [{ key: 'a' }, { key: 'b' }];
  assert.deepEqual(nodesFromStore({ values: () => nodes }), nodes);
  assert.deepEqual(nodesFromStore(new Map([['a', 1]])), [1]);
  assert.deepEqual(nodesFromStore(nodes), nodes);
  assert.deepEqual(nodesFromStore(null), []);
  assert.deepEqual(nodesFromStore({}), []);
  assert.deepEqual(nodesFromStore({ values: () => undefined }), []);
});

test('historyFromNodes orders real Chat nodes by anchor and skips hidden ones', () => {
  const node = (kind, text, anchorSeq, visibility = 'visible') => ({
    key: kind + anchorSeq,
    kind,
    visibility,
    anchorSeq,
    data: { seq: anchorSeq, content: [{ type: 'text', text }] },
  });
  const attachmentOnly = node('user', 'ignored', 35);
  attachmentOnly.data.content = [{ type: 'image', attachmentId: 'x' }];
  const nodes = [
    node('user', 'second', 20),
    node('system-prompt', 'prompt', 5),
    node('user', 'first', 10),
    node('assistant', 'reply', 15),
    node('user', 'hidden', 25, 'hidden'),
    node('steering', 'note', 30),
    attachmentOnly,
  ];
  assert.deepEqual(historyFromNodes(nodes), ['first', 'second', 'note']);
});

test('legacy data-only entries and plain text content still read', () => {
  assert.equal(textOfNode({ content: [{ type: 'text', text: 'legacy' }] }), 'legacy');
  assert.equal(textOfNode({ content: 'plain string' }), 'plain string');
  assert.equal(textOfNode({ text: 'system prompt style' }), 'system prompt style');
  assert.deepEqual(historyFromNodes([
    { kind: 'user', visibility: 'visible', content: [{ type: 'text', text: 'older api shape' }] },
  ]), ['older api shape']);
});

test('harness-authored messages are skipped, typed ones are kept', () => {
  const node = (text, source, anchorSeq) => ({
    key: `k${anchorSeq}`,
    kind: 'user',
    visibility: 'visible',
    anchorSeq,
    data: { seq: anchorSeq, content: [{ type: 'text', text }], source },
  });
  const nodes = [
    node('typed one', { kind: 'user', rpcId: 'r1' }, 1),
    node('<goal_round>…', { kind: 'goal', goalId: 'g', revision: 1, round: 1 }, 2),
    node('runtime snapshot', { kind: 'runtime-context', form: 'snapshot' }, 3),
    node('catalog', { kind: 'skill-catalog', form: 'catalog' }, 4),
    node('job notice', { kind: 'tool-jobs', form: 'notice' }, 5),
    node('model notice', { kind: 'model-selection', form: 'notice' }, 6),
    node('checkpoint', { kind: 'compact-checkpoint' }, 7),
    node('approval answer', { kind: 'user-approval' }, 8),
    node('typed two', { kind: 'user', rpcId: 'r2' }, 9),
    node('unknown provenance', { kind: 'something-else' }, 10),
    node('no provenance', undefined, 11),
    node('steer', { kind: 'user', rpcId: 'r3' }, 12),
  ];
  nodes[11].kind = 'steering';
  assert.deepEqual(historyFromNodes(nodes), ['typed one', 'typed two', 'unknown provenance', 'no provenance', 'steer']);
});

/** Build one fixed-input record shaped like the shortcuts service's. */
function keyEvent(code, overrides = {}) {
  const root = { closest: (selector) => (selector === '[data-lexical-editor="true"]' ? root : null) };
  const event = {
    type: 'keydown',
    consumed: 0,
    gesture: {
      code,
      defaultPrevented: false,
      composing: false,
      control: false,
      alt: false,
      meta: false,
      shift: false,
      ...overrides,
    },
    context: { region: 'editable', target: root },
    consume() {
      event.consumed += 1;
    },
  };
  return event;
}
