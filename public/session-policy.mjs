/** Pure UI policy and archive selection. This does not validate or migrate model versions. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The UI accepts only the literal baseline mechanism, including no stale extra parameters. */
export function isMainFlowSession(state) {
  const mechanism = state?.config?.mechanism;
  return object(mechanism) && Object.keys(mechanism).length === 1
    && own(mechanism, 'kind') && mechanism.kind === 'random_removal';
}

/** Call before assigning current, persisting, or requesting advice. Core restore checks versions. */
export function assertMainFlowSession(state) {
  if (!isMainFlowSession(state)) {
    throw policyError('LEGACY_SCENARIO_SESSION', '此记录包含旧研究情景或不兼容的机制参数，不能在当前主流程继续。原记录未转换或删除，可原样导出；请另建仅输入剩余抽数的会话。');
  }
  return state;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((part, index) => sameJson(part, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && sameJson(left[key], right[key]));
}

/** Check before effects: a matching ID must retain its fixed interpretation and valuation. */
export function assertSessionCanBeSaved(store, state) {
  assertMainFlowSession(state);
  if (!own(store?.sessions, state.session_id)) return state;
  const existing = store.sessions[state.session_id]?.state;
  if (!isMainFlowSession(existing) || existing.schema_version !== state.schema_version
      || existing.model_version !== state.model_version || existing.catalog_version !== state.catalog_version
      || !sameJson(existing.config, state.config)) {
    throw policyError('SESSION_ID_CONFLICT', '同一会话标识已有不同情景、版本或固定估值的存档。原记录未覆盖；请保留原文件并使用新的会话标识。');
  }
  // Same fixed configuration may have a different ledger after explicit restore, record or undo.
  return state;
}

function savedState(store, id) {
  const sessions = store?.sessions;
  if (!own(sessions, id)) throw policyError('UNKNOWN_SAVED_SESSION', '找不到所选存档，未改为导出其他会话。');
  const entry = sessions[id];
  if (!own(entry, 'state') || !object(entry.state)) throw policyError('INVALID_SAVED_SESSION', '所选存档缺少原始会话对象，无法导出。');
  return entry.state;
}

/** Explicit selection wins; never silently substitute current for an unavailable selection. */
export function selectExportState(store, selectedId, current) {
  if (selectedId !== undefined && selectedId !== null && selectedId !== '') {
    if (typeof selectedId !== 'string') throw policyError('INVALID_SAVED_SESSION_SELECTION', '请选择有效的存档标识。');
    return savedState(store, selectedId);
  }
  if (object(current)) return current;
  if (typeof store?.activeId === 'string' && store.activeId !== '') return savedState(store, store.activeId);
  throw policyError('NO_EXPORT_SESSION', '没有可导出的当前会话或存档。');
}

/** Serialize the selected object as-is, without restore, guard, migration or ledger changes. */
export function exportSessionArchive(store, selectedId, current) {
  const state = selectExportState(store, selectedId, current);
  const id = typeof state.session_id === 'string' ? state.session_id : 'archive';
  const safeId = id.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'archive';
  const version = Number.isInteger(state.schema_version) ? `v${state.schema_version}` : 'archive';
  return { state, json: JSON.stringify(state, null, 2), filename: `ark54-${version}-session-${safeId}.json` };
}
