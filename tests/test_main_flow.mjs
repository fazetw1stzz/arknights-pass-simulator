/** Actual app.mjs flow checks with memory-only DOM/storage substitutes.
 * This is not browser, rendering, accessibility, or visual acceptance testing.
 * The production source is read unchanged; only its in-memory module copy gains a test seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const appUrl = process.env.MAIN_FLOW_APP
  ? pathToFileURL(process.env.MAIN_FLOW_APP)
  : new URL('../public/app.mjs', import.meta.url);
const { dispatch } = await import(new URL('./model.mjs', appUrl));
const catalog = JSON.parse(readFileSync(new URL('./data/box54.json', appUrl), 'utf8').replace(/^\uFEFF/, ''));
const source = readFileSync(appUrl, 'utf8').replace(/^\uFEFF/, '');
const ids = catalog.items.map(item => item.id);
const STORE_KEY = 'ark-pass-web-mvp-v2';
const clone = value => structuredClone(value);
let moduleNumber = 0;

function fixture(id, mechanism = { kind: 'random_removal' }) {
  const state = dispatch({ op: 'create', input: {
    session_id: id, box_id: '54.0', initial_remaining: 4,
    mode: 'preference', values: Object.fromEntries(ids.map(item => [item, 20])),
    cost: 25, budget: 100, packing_ack: true,
    valuation_meta: { kind: 'explicit_values' }, target_ids: [ids[0]],
    mechanism: { kind: 'random_removal' },
  } }, catalog);
  state.config.mechanism = clone(mechanism);
  // Preserve a tombstone too: no archive path may silently rebuild the ledger.
  state.events = [{ event_id: 'original-undone', item_id: ids[2], status: 'undone' }];
  return state;
}

const legacyMechanisms = [
  ['target_stop', { kind: 'target_stop', target_ids: [ids[0], ids[1]], hit_limit: 1, max_draws: 14 }],
  ['fixed_draws', { kind: 'fixed_draws', draws: 10 }],
];

function archive(...states) {
  return { version: 2, activeId: states[0]?.session_id ?? null,
    sessions: Object.fromEntries(states.map(state => [state.session_id, {
      state: clone(state), createdAt: '2026-10-20T01:02:03Z', savedAt: '2026-10-21T04:05:06Z',
    }])) };
}

class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.hidden = false; this.disabled = false;
    this.checked = false; this.innerHTML = ''; this.textContent = ''; this.dataset = {};
    this.listeners = new Map(); this.style = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute() {}
  focus() {}
  scrollIntoView() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  click() { this.clicked = true; }
}

async function harness(saved = archive(), current = null) {
  const elements = new Map(), calls = [], downloads = [], blobs = [];
  const raw = JSON.stringify(saved);
  const memory = new Map([[STORE_KEY, raw]]);
  let writes = 0;
  const element = id => {
    if (!elements.has(id)) {
      const value = new Element(id);
      if (/^weight-\d$/.test(id)) value.value = String([100, 60, 20, 0, -30][Number(id.slice(-1))]);
      if (id === 'willingness') value.value = '100';
      if (id === 'initial-remaining') value.value = '14';
      if (id === 'draw-cost') value.value = '25';
      if (id === 'target-definition') value.value = 'favorite';
      elements.set(id, value);
    }
    return elements.get(id);
  };
  const preference = new Element(); preference.value = 'preference'; preference.checked = true;
  const price = new Element(); price.value = 'price';
  globalThis.document = {
    body: new Element('body'), documentElement: new Element('html'),
    getElementById: element,
    querySelector(selector) {
      if (selector.includes('valuation-mode')) return selector.includes('value="price"') ? price : preference;
      return null;
    },
    querySelectorAll(selector) { return selector === 'input[name="valuation-mode"]' ? [preference, price] : []; },
    createElement(tag) {
      const result = new Element(tag);
      if (tag === 'a') result.click = () => downloads.push({ filename: result.download, href: result.href });
      return result;
    },
  };
  globalThis.localStorage = {
    getItem(key) { return memory.get(key) ?? null; },
    setItem(key, value) { writes++; memory.set(key, value); },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => clone(catalog) });
  globalThis.__mainFlowApi = {
    async getRuntime() { return { compute: 'browser' }; },
    async call(request, suppliedCatalog) {
      calls.push(clone(request));
      return dispatch(request, suppliedCatalog);
    },
  };
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:memory-${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  let instrumented = source.replace(
    /^import\s+\{\s*call,\s*getRuntime\s*\}\s+from\s+['"]\.\/api\.mjs['"];?\r?\n/m,
    'const {call, getRuntime} = globalThis.__mainFlowApi;\n',
  );
  assert.notEqual(instrumented, source, 'API seam must match the actual import.');
  instrumented = instrumented.replace(/from\s+(['"])(\.\/[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, appUrl).href}${quote}`);
  assert.match(instrumented, /\ninitialize\(\);?\s*$/, 'Automatic initialization must be explicit in the source.');
  instrumented = instrumented.replace(/\ninitialize\(\);?\s*$/, '\n');
  instrumented += `\nexport const __test = { initialize, activate, saveSession, restoreMainFlow, wireEvents, buildInput,
    setEnvironment(c, s, active) { catalog=c; store=s; current=active; },
    snapshot() { return {current, store, recommendation, busy}; } };\n// test instance ${++moduleNumber}\n`;
  const { __test: app } = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
  app.setEnvironment(clone(catalog), clone(saved), clone(current));
  async function emit(id, type, extra = {}) {
    const target = element(id);
    const event = { target, preventDefault() {}, ...extra };
    for (const handler of target.listeners.get(type) || []) await handler(event);
    // import/setup handlers launch task() without returning it; drain their promise chain.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.snapshot().busy, false, `${id}/${type} must finish.`);
  }
  return { app, element, calls, downloads, blobs, emit,
    raw: () => memory.get(STORE_KEY), writes: () => writes,
    close() { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; },
  };
}

for (const [kind, mechanism] of legacyMechanisms) {
  test(`${kind}: actual auto-restore rejects before computation and preserves the archive`, async () => {
    const old = fixture(`auto-${kind}`, mechanism), saved = archive(old), h = await harness(saved);
    try {
      await h.app.initialize();
      assert.equal(h.app.snapshot().current, null);
      assert.deepEqual(h.calls, []);
      assert.equal(h.writes(), 0); assert.equal(h.raw(), JSON.stringify(saved));
      assert.deepEqual(h.app.snapshot().store, saved);
      assert.equal(h.element('setup-view').hidden, false);
      assert.equal(h.element('app-error').hidden, false);
      assert.equal(h.element('saved-session').value, old.session_id);
      assert.equal(h.element('export-session').disabled, false);
    } finally { h.close(); }
  });

  test(`${kind}: actual manual restore leaves an existing current session unchanged`, async () => {
    const old = fixture(`manual-${kind}`, mechanism), baseline = fixture('live'), saved = archive(old, baseline);
    const h = await harness(saved, baseline);
    try {
      h.app.wireEvents(); h.element('saved-session').value = old.session_id;
      await h.emit('restore-saved', 'click');
      assert.deepEqual(h.app.snapshot().current, baseline); assert.deepEqual(h.calls, []);
      assert.equal(h.raw(), JSON.stringify(saved)); assert.equal(h.writes(), 0);
      assert.deepEqual(h.app.snapshot().store, saved);
    } finally { h.close(); }
  });

  test(`${kind}: actual JSON import rejects before restore/save/advice`, async () => {
    const old = fixture(`import-${kind}`, mechanism), baseline = fixture('live'), saved = archive(baseline);
    const originalFile = `${JSON.stringify(old, null, 4)}\n`, h = await harness(saved, baseline);
    try {
      h.app.wireEvents();
      h.element('import-file').files = [{ size: Buffer.byteLength(originalFile), text: async () => originalFile }];
      await h.emit('import-file', 'change');
      assert.deepEqual(h.calls, []); assert.deepEqual(h.app.snapshot().current, baseline);
      assert.equal(h.raw(), JSON.stringify(saved)); assert.equal(h.writes(), 0);
      assert.deepEqual(h.app.snapshot().store, saved);
      assert.equal(originalFile, `${JSON.stringify(old, null, 4)}\n`);
    } finally { h.close(); }
  });

  test(`${kind}: actual activate/save private entry points reject before effects`, async () => {
    const old = fixture(`direct-${kind}`, mechanism), baseline = fixture('live'), saved = archive(old, baseline);
    const h = await harness(saved, baseline);
    try {
      await assert.rejects(h.app.activate(old), error => error.code === 'LEGACY_SCENARIO_SESSION');
      await assert.rejects(h.app.activate(old, false), error => error.code === 'LEGACY_SCENARIO_SESSION');
      assert.throws(() => h.app.saveSession(old), error => error.code === 'LEGACY_SCENARIO_SESSION');
      assert.deepEqual(h.app.snapshot().current, baseline); assert.deepEqual(h.calls, []);
      assert.equal(h.writes(), 0); assert.equal(h.raw(), JSON.stringify(saved));
      assert.deepEqual(h.app.snapshot().store, saved);
    } finally { h.close(); }
  });

  test(`${kind}: actual export handler downloads selected original history without activating it`, async () => {
    const old = fixture(`export-${kind}`, mechanism), baseline = fixture('live'), saved = archive(old, baseline);
    const h = await harness(saved, baseline);
    try {
      h.app.wireEvents(); h.element('saved-session').value = old.session_id;
      await h.emit('export-session', 'click');
      assert.equal(h.downloads.length, 1); assert.equal(h.blobs.length, 1);
      assert.deepEqual(JSON.parse(await h.blobs[0].text()), old);
      assert.deepEqual(h.app.snapshot().current, baseline); assert.deepEqual(h.calls, []);
      assert.equal(h.writes(), 0); assert.equal(h.raw(), JSON.stringify(saved));
      assert.match(h.downloads[0].filename, new RegExp(`${old.session_id}\\.json$`));
    } finally { h.close(); }
  });

  test(`${kind}: baseline import with the same ID cannot replace an old scenario`, async () => {
    const old = fixture(`collision-${kind}`, mechanism), baseline = fixture('live'), saved = archive(old, baseline);
    const incoming = fixture(old.session_id), h = await harness(saved, baseline);
    try {
      h.app.wireEvents(); const raw = JSON.stringify(incoming);
      h.element('import-file').files = [{ size: Buffer.byteLength(raw), text: async () => raw }];
      await h.emit('import-file', 'change');
      assert.deepEqual(h.calls.map(request => request.op), ['restore'], 'Only core validation may happen; no recommendation.');
      assert.deepEqual(h.app.snapshot().current, baseline);
      assert.deepEqual(h.app.snapshot().store, saved);
      assert.equal(h.writes(), 0); assert.equal(h.raw(), JSON.stringify(saved));
      assert.equal(h.element('app-error').hidden, false);
    } finally { h.close(); }
  });
}

test('a valid baseline still auto-restores, saves its active pointer and requests advice', async () => {
  const baseline = fixture('accepted-baseline'), saved = archive(baseline), h = await harness(saved);
  try {
    await h.app.initialize();
    assert.deepEqual(h.calls.map(request => request.op), ['restore', 'recommend']);
    assert.deepEqual(h.app.snapshot().current, baseline);
    assert.equal(h.app.snapshot().recommendation.method, 'exact_bitmask_belief_dp');
    assert.equal(h.element('result-view').hidden, false);
    assert.equal(h.writes(), 1); assert.deepEqual(JSON.parse(h.raw()).sessions, saved.sessions);
  } finally { h.close(); }
});

test('actual setup creates the literal random-removal mechanism without prior outcomes', async () => {
  const h = await harness();
  try {
    await h.app.initialize();
    h.element('initial-remaining').value = '3'; h.element('packing-ack').checked = true;
    h.element('willingness').value = '100';
    catalog.items.forEach((item, index) => { h.element(`rating-${item.id}`).value = index === 0 ? '0' : '3'; });
    // Even a stale element value cannot inject a research mechanism into buildInput().
    h.element('mechanism-kind').value = 'target_stop';
    h.element('predecessor-hit-limit').value = '2';
    h.element('predecessor-max-draws').value = '14';
    const input = h.app.buildInput();
    assert.deepEqual(input.mechanism, { kind: 'random_removal' });
    assert.equal(input.initial_remaining, 3);
    assert.equal(Object.hasOwn(input, 'observed'), false);
    assert.equal(Object.hasOwn(input, 'previously_drawn'), false);
    assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});
