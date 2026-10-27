import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatch } from '../public/model.mjs';
import { assertMainFlowSession, assertSessionCanBeSaved, isMainFlowSession, selectExportState, exportSessionArchive } from '../public/session-policy.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const session = (mechanism, id = 'record') => ({ schema_version: 2, model_version: 'residual-items-v2', catalog_version: 'test', session_id: id,
  config: { mechanism, valuation_meta: { kind: 'explicit_values', original_note: '旧记录保持原意' }, values: { A: -30, B: 100 }, target_ids: ['A'], cost: 25, budget: null },
  events: [{ event_id: 'old-1', item_id: 'A', status: 'undone' }, { event_id: 'old-2', item_id: 'B', status: 'active' }] });
const baseline = session({ kind: 'random_removal' }, 'baseline');
const target = session({ kind: 'target_stop', target_ids: ['A'], hit_limit: 1, max_draws: 9 }, 'target');
const fixed = session({ kind: 'fixed_draws', draws: 4 }, 'fixed');

test('only exact baseline mechanism is permitted and guards never edit an input', () => {
  const allowed = freeze(clone(baseline));
  assert.equal(isMainFlowSession(allowed), true);
  assert.equal(assertMainFlowSession(allowed), allowed, 'Preserve identity and values, not a rewritten session.');
  for (const mechanism of [target.config.mechanism, fixed.config.mechanism, { kind: 'unknown' }, { kind: 'random_removal', draws: 0 }, {}, null]) {
    const state = freeze(session(clone(mechanism)));
    const before = JSON.stringify(state);
    assert.equal(isMainFlowSession(state), false);
    assert.throws(() => assertMainFlowSession(state), error => error.code === 'LEGACY_SCENARIO_SESSION');
    assert.equal(JSON.stringify(state), before);
  }
  assert.equal(isMainFlowSession({ config: {} }), false);
});

test('inherited mechanism fields cannot impersonate the literal baseline', () => {
  const mechanism = Object.create({ kind: 'random_removal' });
  assert.equal(isMainFlowSession({ config: { mechanism } }), false);
});

test('guard-before-effects flow simulation blocks legacy activation without touching current/store', () => {
  // Pure flow simulation, not a GUI/browser test. It checks the integration ordering contract.
  const store = freeze({ version: 2, activeId: 'target', sessions: { target: { state: clone(target), savedAt: 'preserved' }, baseline: { state: clone(baseline) } } });
  const originalStore = JSON.stringify(store);
  const effects = [];
  let current = baseline;
  function activate(state) {
    assertMainFlowSession(state);
    effects.push('assign-current'); current = state;
    effects.push('save'); effects.push('recommend');
  }
  assert.throws(() => activate(target), error => error.code === 'LEGACY_SCENARIO_SESSION');
  assert.deepEqual(effects, []); assert.equal(current, baseline);
  assert.equal(JSON.stringify(store), originalStore); assert.equal(store.activeId, 'target');
  activate(baseline); assert.deepEqual(effects, ['assign-current', 'save', 'recommend']);
});

test('explicit old selection exports the original state and ledger even with an active baseline', () => {
  const store = freeze({ version: 2, activeId: 'target', sessions: {
    target: { state: clone(target), label: '旧研究情景' }, fixed: { state: clone(fixed) }, baseline: { state: clone(baseline) },
  } });
  const before = JSON.stringify(store);
  for (const id of ['target', 'fixed']) {
    const result = exportSessionArchive(store, id, baseline);
    assert.equal(result.state, store.sessions[id].state);
    assert.equal(result.json, JSON.stringify(store.sessions[id].state, null, 2), 'Serialized bytes must contain the unchanged selected object.');
    assert.deepEqual(JSON.parse(result.json), store.sessions[id].state);
    assert.match(result.filename, new RegExp(`v2-session-${id}\\.json$`));
    assert.deepEqual(JSON.parse(result.json).events, store.sessions[id].state.events);
  }
  assert.equal(JSON.stringify(store), before); assert.equal(store.activeId, 'target');
});

test('export fallback order is current then stored active ID; missing selection never substitutes', () => {
  const store = freeze({ version: 2, activeId: 'target', sessions: { target: { state: clone(target) } } });
  assert.equal(selectExportState(store, '', baseline), baseline);
  assert.equal(selectExportState(store, '', null), store.sessions.target.state);
  assert.equal(selectExportState(store, undefined, null), store.sessions.target.state);
  assert.throws(() => selectExportState(store, 'missing', baseline), error => error.code === 'UNKNOWN_SAVED_SESSION');
  assert.throws(() => selectExportState(store, '__proto__', baseline), error => error.code === 'UNKNOWN_SAVED_SESSION');
  assert.throws(() => selectExportState(store, false, baseline), error => error.code === 'INVALID_SAVED_SESSION_SELECTION');
  assert.throws(() => selectExportState({ sessions: {} }, '', null), error => error.code === 'NO_EXPORT_SESSION');
  assert.equal(store.activeId, 'target'); assert.equal(store.sessions.target.state.config.mechanism.kind, 'target_stop');
});

test('same-ID legacy or different fixed valuations cannot be overwritten by an incoming baseline', () => {
  const store = freeze({ version: 2, activeId: 'target', sessions: { target: { state: clone(target) }, baseline: { state: clone(baseline) } } });
  const before = JSON.stringify(store);
  const collidingLegacy = clone(baseline); collidingLegacy.session_id = 'target';
  const changedValuation = clone(baseline); changedValuation.config.values.A = 100;
  const changedVersion = clone(baseline); changedVersion.catalog_version = 'different-catalog';
  for (const state of [collidingLegacy, changedValuation, changedVersion]) {
    freeze(state);
    assert.throws(() => assertSessionCanBeSaved(store, state), error => error.code === 'SESSION_ID_CONFLICT');
  }
  assert.equal(JSON.stringify(store), before); assert.equal(store.activeId, 'target');
});

test('same configuration allows an explicit ledger restore irrespective of object key order', () => {
  const store = freeze({ version: 2, activeId: 'baseline', sessions: { baseline: { state: clone(baseline) } } });
  const incoming = clone(baseline);
  incoming.config = Object.fromEntries(Object.entries(incoming.config).reverse());
  incoming.config.values = { B: 100, A: -30 };
  incoming.events = [{ event_id: 'restored-ledger', item_id: 'B', status: 'active' }];
  freeze(incoming);
  const before = JSON.stringify(store);
  assert.equal(assertSessionCanBeSaved(store, incoming), incoming);
  assert.equal(JSON.stringify(store), before);
  const fresh = clone(incoming); fresh.session_id = 'new-baseline'; freeze(fresh);
  assert.equal(assertSessionCanBeSaved(store, fresh), fresh);
  const nextStore = { ...store, sessions: { ...store.sessions, [fresh.session_id]: { state: fresh } } };
  assert.equal(nextStore.sessions.baseline, store.sessions.baseline);
  assert.equal(store.sessions['new-baseline'], undefined);
});

test('early v2 import guard preserves rejected raw JSON, current and saved records', () => {
  const source = `${JSON.stringify(target, null, 4)}\n`;
  const store = freeze({ version: 2, activeId: 'baseline', sessions: { baseline: { state: clone(baseline) }, target: { state: clone(target) } } });
  const before = JSON.stringify(store), parsed = JSON.parse(source);
  assert.throws(() => { if (parsed.schema_version === 2) assertMainFlowSession(parsed); }, error => error.code === 'LEGACY_SCENARIO_SESSION');
  assert.equal(JSON.stringify(store), before); assert.equal(source, `${JSON.stringify(target, null, 4)}\n`);
  assert.deepEqual(parsed, target);
});

const catalog = JSON.parse(readFileSync(new URL('../public/data/box54.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const ids = catalog.items.map(item => item.id);
const createInput = { session_id: 'own-observations', box_id: '54.0', initial_remaining: 5, mode: 'preference',
  values: Object.fromEntries(ids.map(id => [id, 100])), cost: 25, budget: null, packing_ack: true,
  valuation_meta: { kind: 'explicit_values' }, target_ids: [ids[0]], mechanism: { kind: 'random_removal' } };

test('baseline own observations update the belief while physical inventory remains distinct', () => {
  let state = dispatch({ op: 'create', input: createInput }, catalog);
  state = dispatch({ op: 'record', state, event_id: 'mine-1', item_id: ids[3] }, catalog);
  state = dispatch({ op: 'record', state, event_id: 'mine-2', item_id: ids[7] }, catalog);
  assert.equal(assertMainFlowSession(state), state);
  const advice = dispatch({ op: 'recommend', state }, catalog);
  assert.equal(advice.actual_remaining, 3); assert.equal(advice.latent_count, 12); assert.equal(advice.max_future_draws, 3);
  const target = advice.probabilities.find(row => row.item_id === ids[0]);
  assert.ok(Math.abs(target.p - 1/12) < 1e-12); assert.ok(Math.abs(target.presence_probability - 1/4) < 1e-12);
  assert.equal(advice.probabilities.find(row => row.item_id === ids[3]).p, 0);
});

test('v1 import version rejection remains the core responsibility; export does not migrate it', () => {
  const state = dispatch({ op: 'create', input: createInput }, catalog), v1 = clone(state);
  v1.schema_version = 1; v1.model_version = 'random-removal-items-v1'; delete v1.config.mechanism; delete v1.config.target_ids;
  const payload = JSON.stringify(v1), effects = [];
  assert.throws(() => {
    const parsed = JSON.parse(payload);
    if (parsed.schema_version === 2) assertMainFlowSession(parsed);
    effects.push('core-restore');
    dispatch({ op: 'restore', payload: parsed }, catalog);
  }, error => error.code === 'VERSION_MISMATCH');
  assert.deepEqual(effects, ['core-restore']);
  const archive = exportSessionArchive({ activeId: 'old', sessions: { old: { state: v1 } } }, 'old', baseline);
  assert.deepEqual(JSON.parse(archive.json), v1); assert.match(archive.filename, /v1-session-/);
});
