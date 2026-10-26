import { call, getRuntime } from './api.mjs';
import { buildProbabilityGroups, summarizeAdviceDisplay, percent } from './ui-utils.mjs';

const $ = id => document.getElementById(id);
const LEVELS = ['我推!!', '不错', '能接受', '无感', '不喜欢'];
const DEFAULT_WEIGHTS = [100, 60, 20, 0, -30];
const STORE_KEY = 'ark-pass-web-mvp-v2';
let catalog;
let current = null;
let recommendation = null;
let busy = false;
let storageWorks = true;
let store = { version: 2, activeId: null, sessions: {} };
let pendingRecord = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const num = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = value => value == null ? '—' : `${Number(value) > 1e-9 ? '+' : ''}${num(value)}`;
const mode = () => document.querySelector('input[name="valuation-mode"]:checked').value;
const roleItems = roleId => catalog.items.filter(item => item.role_id === roleId);
const itemById = id => catalog.items.find(item => item.id === id);
const activeEvents = state => state.events.filter(event => event.status === 'active');
const editionLabel = item => item.edition_label || (item.edition === 'ELITE1' ? '常规（精英一）' : '精英二');
const roleName = item => item.role_name || catalog.roles.find(role => role.id === item.role_id)?.name || item.role_id;

function problem(message, fieldId) {
  const error = new Error(message);
  error.fieldId = fieldId;
  return error;
}

function showError(error) {
  $('app-success').hidden = true;
  const messages = {
    VERSION_MISMATCH: '会话版本不兼容。v0.2不自动迁移v0.1会话；旧记录未删除，请使用保留的v0.1历史版查看。',
    VALUATION_MISMATCH: '固定估值与五档权重、愿付尺度或档位不一致。没有重新计算或改写历史，请检查原始JSON或建立新会话。',
    INVALID_VALUATION_METADATA: '估值元数据不符合v0.2契约，无法可靠解释喜好档位。请检查JSON；页面不会猜测或补填。',
    UNSUPPORTED_N: '该前人停手规则不可能留下输入的剩余抽数。请核对现场数量或更换明确的假设；不会为零概率状态编造先验。',
    UNSUPPORTED_OBSERVATION: '该实际结果与当前前人规则及既有记录不相容。记录未写入；请核对误录，或在新会话中修正前人假设。',
  };
  $('app-error').textContent = messages[error?.code] || error?.message || '操作未完成，请检查输入后重试。';
  $('app-error').hidden = false;
  const field = error?.fieldId && $(error.fieldId);
  if (field) field.focus();
  else $('app-error').focus({ preventScroll: true });
}

function success(message) {
  $('app-error').hidden = true;
  $('app-success').textContent = message;
  $('app-success').hidden = false;
}

function clearFeedback() {
  $('app-error').hidden = true;
  $('app-success').hidden = true;
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  $('main').setAttribute('aria-busy', String(value));
  $('start-button').disabled = value;
  updateRecordAvailability();
}

async function task(callback) {
  if (busy) return;
  clearFeedback();
  setBusy(true);
  try { await callback(); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
}

function options(selected = '') {
  return `<option value=""${selected === '' ? ' selected' : ''}>请选择喜好</option>${LEVELS.map((label, index) => `<option value="${index}"${String(selected) === String(index) ? ' selected' : ''}>${esc(label)}</option>`).join('')}`;
}

function setupControls() {
  $('weight-fields').innerHTML = LEVELS.map((label, index) => `<label class="weight-cell"><span>${esc(label)}</span><input id="weight-${index}" type="number" step="1" value="${DEFAULT_WEIGHTS[index]}" inputmode="decimal" aria-label="${esc(label)}权重"></label>`).join('');
  $('role-grid').innerHTML = catalog.roles.map((role, index) => {
    const image = typeof role.image === 'string' ? role.image : role.image?.url || role.image?.path;
    return `<article class="role-card${image ? ' has-image' : ''}" data-role="${esc(role.id)}">${image ? `<img class="role-art" src="${esc(image)}" alt="${esc(role.name)}双版本商品参考图" loading="lazy">` : ''}<div class="role-card-head"><span class="role-number">${String(index + 1).padStart(2, '0')}</span><span class="role-name">${esc(role.name)}</span></div><div class="role-body"><label class="field role-shared preference-only"><span>角色喜好 · 默认同步两款</span><select id="role-rating-${esc(role.id)}" data-role-rating="${esc(role.id)}" aria-label="${esc(role.name)}角色喜好">${options()}</select></label><div class="variant-grid">${roleItems(role.id).map(item => `<div><label class="field preference-only"><span>${esc(editionLabel(item))}</span><select id="rating-${esc(item.id)}" data-item-rating="${esc(item.id)}" aria-label="${esc(role.name)} ${esc(editionLabel(item))} 喜好">${options()}</select></label><label class="field price-only" hidden><span>${esc(editionLabel(item))} · 元</span><input id="price-${esc(item.id)}" data-item-price="${esc(item.id)}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="待填写" aria-label="${esc(role.name)} ${esc(editionLabel(item))} 参考价格"></label><label class="item-check price-only" hidden><input id="price-target-${esc(item.id)}" type="checkbox" data-price-target="${esc(item.id)}"><span>把这款设为我的目标</span></label><div id="preview-${esc(item.id)}" class="value-preview">尚未赋值</div></div>`).join('')}</div></div></article>`;
  }).join('');
  $('predecessor-targets').innerHTML = catalog.roles.map(role => `<fieldset class="target-role"><legend>${esc(role.name)}</legend>${roleItems(role.id).map(item => `<label class="item-check"><input id="predecessor-target-${esc(item.id)}" type="checkbox" data-predecessor-target="${esc(item.id)}"><span>${esc(editionLabel(item))}</span></label>`).join('')}</fieldset>`).join('');
  $('role-grid').querySelectorAll('img').forEach(image => image.addEventListener('error', () => { image.hidden = true; }));
  document.querySelectorAll('input[name="valuation-mode"]').forEach(radio => radio.addEventListener('change', updateMode));
  $('role-grid').addEventListener('change', event => {
    const roleId = event.target.dataset.roleRating;
    if (roleId) roleItems(roleId).forEach(item => { $(`rating-${item.id}`).value = event.target.value; });
    updatePreviews();
  });
  $('role-grid').addEventListener('input', updatePreviews);
  $('weight-fields').addEventListener('input', updatePreviews);
  $('willingness').addEventListener('input', updatePreviews);
  $('target-definition').addEventListener('change', updateTargetSummary);
  $('mechanism-kind').addEventListener('change', updateMechanismControls);
  $('predecessor-targets').addEventListener('change', updateMechanismControls);
  $('predecessor-clear').addEventListener('click', () => {
    catalog.items.forEach(item => { $(`predecessor-target-${item.id}`).checked = false; });
    updateMechanismControls();
  });
  $('all-neutral').addEventListener('click', () => {
    catalog.roles.forEach(role => { $(`role-rating-${role.id}`).value = '3'; });
    catalog.items.forEach(item => { $(`rating-${item.id}`).value = '3'; });
    updatePreviews();
  });
  updateMode();
  updateMechanismControls();
}

function weightValues() {
  return LEVELS.map((_, index) => {
    const raw = $(`weight-${index}`).value.trim();
    return raw === '' ? NaN : Number(raw);
  });
}

function updateMode() {
  const preference = mode() === 'preference';
  document.querySelectorAll('.mode-card').forEach(card => card.classList.toggle('selected', card.querySelector('input').checked));
  document.querySelectorAll('.preference-only').forEach(element => { element.hidden = !preference; });
  document.querySelectorAll('.price-only').forEach(element => { element.hidden = preference; });
  $('preference-settings').hidden = !preference;
  $('all-neutral').hidden = !preference;
  $('preference-target-controls').hidden = !preference;
  $('price-target-copy').hidden = preference;
  $('assignment-copy').textContent = preference ? '先给角色选一档，默认应用到两款；两款也可分别调整。' : '请分别填写14款的个人参考价。空白代表未知，不会自动按零计。';
  updatePreviews();
}

function updatePreviews() {
  if (!catalog) return;
  const preference = mode() === 'preference';
  const weights = weightValues();
  const willingness = $('willingness').value.trim() === '' ? NaN : Number($('willingness').value);
  let complete = 0;
  const values = [];
  catalog.items.forEach(item => {
    let value = null;
    if (preference) {
      const rating = $(`rating-${item.id}`).value;
      if (rating !== '' && weights.every(Number.isFinite) && weights[0] > 0 && Number.isFinite(willingness) && willingness >= 0) value = willingness * weights[Number(rating)] / weights[0];
    } else {
      const raw = $(`price-${item.id}`).value.trim();
      if (raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) value = Number(raw);
    }
    const preview = $(`preview-${item.id}`);
    preview.textContent = value == null ? (preference ? '尚未选择' : '价格未知') : `${num(value)} ${preference ? '元等值' : '元'}`;
    preview.classList.toggle('negative', value != null && value < 0);
    if (value != null) { complete++; values.push(value); }
  });
  $('assignment-summary').textContent = `已确认 ${complete} / ${catalog.items.length} 款${complete === catalog.items.length ? ` · 本轮完整候选的平均估值 ${num(values.reduce((a, b) => a + b, 0) / values.length)} ${preference ? '元等值' : '元'}` : ' · 全部确认后即可计算'}`;
  updateTargetSummary();
}

function selectedTargetIds() {
  if (mode() === 'price') return catalog.items.filter(item => $(`price-target-${item.id}`).checked).map(item => item.id);
  const limit = $('target-definition').value === 'top_two' ? 1 : 0;
  return catalog.items.filter(item => {
    const raw = $(`rating-${item.id}`).value;
    return raw !== '' && Number(raw) <= limit;
  }).map(item => item.id);
}

function updateTargetSummary() {
  if (!catalog) return;
  const targets = selectedTargetIds();
  $('target-summary').textContent = targets.length ? `我的目标共${targets.length}款：${targets.map(id => { const item = itemById(id); return `${roleName(item)}·${editionLabel(item)}`; }).join('、')}` : '尚未定义目标。价格模式请在各款下方勾选；喜好模式请至少给一款选择对应档位。';
}

function updateMechanismControls() {
  const kind = $('mechanism-kind').value;
  $('target-stop-controls').hidden = kind !== 'target_stop';
  $('fixed-draws-controls').hidden = kind !== 'fixed_draws';
  const count = catalog.items.filter(item => $(`predecessor-target-${item.id}`).checked).length;
  $('predecessor-count').textContent = `前人目标已选${count}款；与我的目标独立，不会自动同步。`;
  $('predecessor-hit-limit').max = String(Math.max(1, count));
  const copy = {
    random_removal: '随机移除对照：此前被抽走的身份视为随机，现场剩余数由你输入。它不能说明前人是追到目标后停手，也不推断残盒出现频率。',
    target_stop: '假设前人从满盒开始，命中其独立目标达到阈值，或达到最多抽数时停手。系统再以你看到的剩余抽数为条件推断残盒；这条行为规则尚无现场验证。',
    fixed_draws: '假设前人从满盒固定抽指定次数后离开；现场输入的剩余数必须等于14减去固定抽数。该规则并非现场事实。',
  };
  $('mechanism-copy').textContent = copy[kind] || '请选择一个明确的试算机制。无法确认前人行为时，各假设的结果应对照理解，不能当作已知现场组成。';
}

function integerInput(id, label, min, max) {
  const raw = $(id).value.trim(), value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < min || value > max) throw problem(`${label}须为${min}到${max}之间的整数。`, id);
  return value;
}

function buildMechanism() {
  const kind = $('mechanism-kind').value;
  if (kind === 'random_removal') return { kind };
  if (kind === 'fixed_draws') return { kind, draws: integerInput('predecessor-fixed-draws', '前人固定抽数', 0, 14) };
  if (kind === 'target_stop') {
    const target_ids = catalog.items.filter(item => $(`predecessor-target-${item.id}`).checked).map(item => item.id);
    if (!target_ids.length) throw problem('请明确勾选前人的目标款。前人的目标不默认为与你相同。', 'predecessor-target-' + catalog.items[0].id);
    return { kind, target_ids, hit_limit: integerInput('predecessor-hit-limit', '前人命中阈值', 1, target_ids.length), max_draws: integerInput('predecessor-max-draws', '前人最多抽数', 0, 14) };
  }
  throw problem('请选择本次用于试算的前人机制。', 'mechanism-kind');
}

function moneyInput(id, name, optional = false) {
  const raw = $(id).value.trim();
  if (optional && raw === '') return null;
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) throw problem(`${name}请填写非负金额，最多两位小数。`, id);
  return value;
}

function buildInput() {
  const n = Number($('initial-remaining').value);
  if ($('initial-remaining').value.trim() === '' || !Number.isInteger(n) || n < 0 || n > catalog.items.length) throw problem('剩余抽数必须是0到14之间的整数。', 'initial-remaining');
  if (!$('packing-ack').checked) throw problem('请先确认“每款各一份、等概率不放回”是本次采用的待核实测试假设。', 'packing-ack');
  const selectedMode = mode();
  const values = {};
  let valuationMeta;
  if (selectedMode === 'preference') {
    const weights = weightValues();
    if (!weights.every(Number.isFinite)) throw problem('五档权重都需要填写有效数字。', 'weight-0');
    if (weights[0] <= 0) throw problem('“我推!!”权重需要大于0，才能作为愿付尺度的换算基准。', 'weight-0');
    const willingness = moneyInput('willingness', '最高愿付尺度');
    const ratings = {};
    catalog.items.forEach(item => {
      const raw = $(`rating-${item.id}`).value;
      if (raw === '') throw problem(`还没有为 ${roleName(item)} · ${editionLabel(item)} 选择喜好。也可以明确选择“无感”。`, `rating-${item.id}`);
      ratings[item.id] = Number(raw);
      values[item.id] = willingness * weights[ratings[item.id]] / weights[0];
    });
    valuationMeta = { kind: 'five_levels', labels: LEVELS, weights, willingness, ratings, unit: 'user_willingness_equivalent' };
  } else {
    catalog.items.forEach(item => {
      const fieldId = `price-${item.id}`;
      if ($(fieldId).value.trim() === '') throw problem(`${roleName(item)} · ${editionLabel(item)} 的价格仍未知，请填写后再计算，不能自动按0元计。`, fieldId);
      values[item.id] = moneyInput(fieldId, `${roleName(item)}的价格`);
    });
    valuationMeta = { kind: 'prices', source: 'user_entered', unit: 'user_reference_price' };
  }
  const cost = moneyInput('draw-cost', '单抽价格');
  if (cost <= 0) throw problem('单抽价格必须大于0。', 'draw-cost');
  const target_ids = selectedTargetIds();
  if (!target_ids.length) throw problem('请至少定义一款我的目标。目标概率不等于喜好效用，请明确选择目标范围。', selectedMode === 'preference' ? 'target-definition' : 'price-target-' + catalog.items[0].id);
  const mechanism = buildMechanism();
  return {
    session_id: globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    box_id: catalog.box_id,
    initial_remaining: n,
    mode: selectedMode,
    values,
    cost,
    budget: moneyInput('budget', '预算', true),
    packing_ack: true,
    valuation_meta: valuationMeta,
    target_ids,
    mechanism,
  };
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.version !== 2 || !parsed.sessions || typeof parsed.sessions !== 'object') throw new Error('本机存档格式或版本不受支持。');
    store = parsed;
  } catch (error) {
    storageWorks = false;
    $('storage-status').textContent = '自动存档不可用；请用导出 JSON 保存。';
  }
}

function persist() {
  if (!storageWorks) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch (_) {
    storageWorks = false;
    $('storage-status').textContent = '本机存储空间不足或不可用；当前记录仍在，请导出 JSON。';
  }
}

function saveSession(state) {
  const old = store.sessions[state.session_id];
  store.sessions[state.session_id] = { state, savedAt: new Date().toISOString(), createdAt: old?.createdAt || new Date().toISOString() };
  store.activeId = state.session_id;
  persist();
  updateSavedSelect();
}

function updateSavedSelect() {
  const entries = Object.entries(store.sessions).sort((a, b) => (b[1].savedAt || '').localeCompare(a[1].savedAt || ''));
  $('saved-session').innerHTML = `<option value="">选择已保存会话（${entries.length}）</option>${entries.map(([id, entry]) => {
    const state = entry.state;
    const when = new Date(entry.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const count = Array.isArray(state?.events) ? state.events.filter(event => event.status === 'active').length : '?';
    return `<option value="${esc(id)}"${current?.session_id === id ? ' selected' : ''}>${esc(when)} · ${state?.config?.mode === 'price' ? '价格' : '喜好'} · ${count}抽</option>`;
  }).join('')}`;
  $('storage-bar').hidden = false;
  $('export-session').disabled = !current;
  $('restore-saved').disabled = entries.length === 0;
}

function displayResult() {
  $('loading-view').hidden = true;
  $('setup-view').hidden = true;
  $('result-view').hidden = false;
  document.querySelectorAll('.step').forEach(element => element.classList.toggle('current', element.dataset.step === 'result'));
}

function displaySetup() {
  $('loading-view').hidden = true;
  $('result-view').hidden = true;
  $('setup-view').hidden = false;
  $('new-session-notice').hidden = !current;
  document.querySelectorAll('.step').forEach(element => element.classList.toggle('current', element.dataset.step === 'setup'));
  $('initial-remaining').value = '14';
  $('packing-ack').checked = false;
  updateSavedSelect();
}

async function activate(state, save = true) {
  current = state;
  recommendation = null;
  pendingRecord = null;
  if (save) saveSession(state);
  else { store.activeId = state.session_id; persist(); updateSavedSelect(); }
  displayResult();
  renderResult();
  recommendation = await call({ op: 'recommend', state: current }, catalog);
  renderResult();
}

function basicSnapshot() {
  const observed = activeEvents(current);
  const spent = Math.round(observed.length * current.config.cost * 100) / 100;
  return {
    actual_remaining: current.config.initial_remaining - observed.length,
    latent_count: catalog.items.length - observed.length,
    unknown_removed: catalog.items.length - current.config.initial_remaining,
    own_draw_count: observed.length,
    spent,
    remaining_budget: current.config.budget == null ? null : Math.round((current.config.budget - spent) * 100) / 100,
    max_future_draws: current.config.initial_remaining - observed.length,
  };
}

function reasonCopy(advice) {
  if (!advice) return '记录已保留，正在获取当前建议。';
  const reasons = {
    empty: '现场可抽库存已归零，本会话结束。候选款式中仍可能有此前被未知移除的款，不能继续抽取。',
    budget: '当前剩余预算不足一次抽取。停止建议来自你的硬预算，不代表剩余款式没有价值。',
    tie: '当前继续抽取的期望优势接近零，按平局停手规则建议先停。',
    indifferent: '当前继续抽取的期望优势接近零，按平局停手规则建议先停。',
    positive_value: '在本次明确假设与全部款式固定估值下，计入后续可停手的选择，经济模型倾向继续。命中目标的风险单独列示，这不等于保证追到目标。',
    positive_continuation: '在本次明确假设与全部款式固定估值下，计入后续可停手的选择，经济模型倾向继续。命中目标的风险单独列示。',
    nonpositive_value: '在当前估值和假设下，即使计入后续选择，继续抽取也没有正的期望优势。',
    not_worthwhile: '在当前估值和假设下，即使计入后续选择，继续抽取也没有正的期望优势。',
  };
  return reasons[advice.reason] || (advice.action === 'buy' ? '按当前固定估值与假设，继续抽取的期望净值为正。' : '按当前固定估值、库存和预算，建议停止抽取。');
}

function renderResult() {
  if (!current) return;
  const info = recommendation || basicSnapshot();
  const preference = current.config.mode === 'preference';
  const unit = preference ? '元等值' : '元';
  const display = summarizeAdviceDisplay(recommendation);
  const baselineOnly = current.config.mechanism.kind === 'random_removal' && current.config.initial_remaining < catalog.items.length;
  if (baselineOnly && recommendation) {
    display.tone = 'amber';
    display.title = recommendation.action === 'buy' ? '仅随机对照下倾向继续' : '仅随机对照下倾向停手';
    display.notes.push('当前仅采用随机移除对照。前人是否按目标选择性停手尚无证据，该结果不能代表已校准的现场机制。');
  }
  $('session-title').textContent = `54.0 · ${preference ? '个人喜好' : '个人参考价格'}`;
  $('valuation-unit-label').textContent = preference ? '个人喜好等值' : '个人参考价格';
  $('recommendation-panel').classList.toggle('stop', display.tone === 'stop');
  $('recommendation-panel').classList.toggle('amber', display.tone === 'amber');
  $('recommendation-title').textContent = recommendation ? display.title : '正在计算风险';
  $('recommendation-icon').textContent = !recommendation ? '?' : display.tone === 'amber' ? '!' : display.tone === 'stop' ? 'Ⅱ' : '↗';
  $('recommendation-reason').textContent = reasonCopy(recommendation);
  $('decision-cautions').innerHTML = display.notes.map(note => `<li>${esc(note)}</li>`).join('');
  $('decision-cautions').hidden = !display.notes.length;
  $('next-ev').textContent = recommendation?.next_ev == null ? '—' : num(recommendation.next_ev);
  $('next-net').textContent = recommendation?.next_net == null ? '—' : signed(recommendation.next_net);
  $('next-net').classList.toggle('positive', Number(recommendation?.next_net) > 1e-9);
  $('next-net').classList.toggle('negative', Number(recommendation?.next_net) < -1e-9);
  $('optimal-value').textContent = recommendation?.optimal_value == null ? '—' : num(recommendation.optimal_value);
  $('result-value-note').textContent = preference ? '效用单位为元等值，不是现金利润。未来累计净效用含下一抽，扣除未来支出，排除已经花费的沉没支出；概率不保证结果。' : '按个人参考价估值，不是已实现利润，未扣成交、运费等成本。未来累计净效用含下一抽，排除已经花费的沉没支出。';
  $('economic-action').textContent = recommendation ? `经济模型动作：${recommendation.action === 'buy' ? '继续' : '停手'}。它优化全部款式的效用减支出，不是直接最大化目标命中率，也不强制命中目标即停。` : '正在读取模型动作。';
  $('actual-remaining').textContent = info.actual_remaining;
  $('latent-count').textContent = info.latent_count;
  $('spent').textContent = `${num(info.spent)}元`;
  $('remaining-budget').textContent = info.remaining_budget == null ? '不设上限' : `${num(info.remaining_budget)}元`;
  $('denominator-explainer').textContent = info.actual_remaining === 0
    ? `现场库存已空。仍有${info.latent_count}款身份未被自己观察到，它们对应未知移除的款式，并不表示现场还能抽。`
    : `此前有${info.unknown_removed}件身份未知的抽取；自己已记录${info.own_draw_count}款。${info.latent_count}款尚未被自己观察，其中${recommendation?.possible_count ?? '待计算'}款在当前假设下仍可能出现。现场实际剩${info.actual_remaining}件，受预算约束最多还能抽${info.max_future_draws}次。下一抽使用后验概率，不把候选身份数当作实物库存。`;
  $('draw-cost-chip').textContent = `每抽 ${num(current.config.cost)} 元`;
  $('model-version').textContent = `模型 ${current.model_version} · 目录 ${current.catalog_version}`;
  renderProbabilities(preference, unit);
  renderRisk(unit);
  renderMechanism();
  renderComparison();
  renderLedger();
  populateDrawRoles();
  updateRecordAvailability();
  updateSavedSelect();
}

function renderProbabilities(preference, unit) {
  const probabilities = recommendation?.probabilities || [];
  const byId = Object.fromEntries(probabilities.map(row => [row.item_id, row]));
  const grouping = buildProbabilityGroups(catalog, probabilities, preference ? 'preference' : 'price', current.config.valuation_meta);
  const groups = grouping.groups;
  $('probability-title').textContent = grouping.title;
  $('probability-grouping-note').textContent = grouping.note;
  $('probability-grouping-note').hidden = !grouping.note;
  $('probability-bars').innerHTML = groups.map(group => `<div class="probability-row"><span class="probability-label" title="${esc(group.label)}">${esc(group.label)}</span><div class="probability-track" role="img" aria-label="${esc(group.label)} ${recommendation ? percent(group.p, 2) : '待计算'}"><div class="probability-fill" style="width:${recommendation ? Math.max(0, Math.min(100, group.p * 100)) : 0}%;background:${group.color}"></div></div><span class="probability-fraction">${recommendation ? percent(group.p) : '—'}</span></div>`).join('');
  const observedIds = new Set(activeEvents(current).map(event => event.item_id));
  $('item-probabilities').innerHTML = catalog.items.map(item => {
    const row = byId[item.id];
    const observed = observedIds.has(item.id);
    const target = current.config.target_ids.includes(item.id);
    return `<div class="item-probability"><span class="${observed ? 'observed' : ''}">${esc(roleName(item))}<br><small>${esc(editionLabel(item))}${observed ? ' · 已记录' : ''}${target ? ' · 我的目标' : ''}</small></span><span>${num(current.config.values[item.id])} ${esc(unit)}</span><span>下一抽 ${row ? percent(row.p, 2) : '—'}<br><small>在盒 ${row ? percent(row.presence_probability, 2) : '—'}</small></span></div>`;
  }).join('');
}

function renderRisk(unit) {
  const risk = recommendation?.risk;
  const money = value => value == null ? '—' : `${num(value)}元`;
  $('next-target-probability').textContent = percent(risk?.next_target_probability);
  $('zero-target-probability').textContent = percent(risk?.remaining_zero_target_probability);
  $('policy-final-miss').textContent = percent(risk?.policy_final_no_target_probability);
  $('expected-additional-spend').textContent = money(risk?.expected_additional_spend);
  $('expected-additional-draws').textContent = risk ? `${num(risk.expected_additional_draws)}抽` : '—';
  $('policy-future-hit').textContent = percent(risk?.policy_future_hit_probability);
  $('policy-loss-probability').textContent = percent(risk?.policy_loss_probability);
  $('observed-target-count').textContent = risk ? `${risk.already_observed_target_count}款` : '—';
  $('policy-risk-note').textContent = !risk ? '正在计算当前后验与可执行策略的风险。' : risk.already_observed_target_count > 0 ? `本次此前已命中${risk.already_observed_target_count}款目标，因此“最终仍未命中”为0；“未来新增至少一款目标”只计算从现在起的新命中。` : '“最终仍未命中”包含策略选择立即或随后停手的结果；它不等于强制抽完所有库存的未命中概率。';
  for (const key of ['p05', 'p50', 'p95']) $('utility-' + key).textContent = risk ? `${signed(risk.net_utility_quantiles[key])} ${unit}` : '—';
  $('utility-range').textContent = risk ? `模型支持的最小／最大结果为${signed(risk.net_utility_min)}／${signed(risk.net_utility_max)} ${unit}。` : '';
  $('remaining-target-distribution').innerHTML = risk ? risk.remaining_target_distribution.map(row => `<div class="distribution-row"><span>剩余${row.count}款目标</span><div class="probability-track" role="img" aria-label="${row.count}款目标 ${percent(row.p)}"><div class="probability-fill" style="width:${Math.max(0, Math.min(100, row.p * 100))}%"></div></div><strong>${percent(row.p, 2)}</strong></div>`).join('') : '<p class="hint">正在计算。</p>';
  $('policy-outcomes').innerHTML = risk ? risk.outcome_distribution.map(row => `<tr><td>${row.draws}</td><td>${row.target_hits}</td><td>${percent(row.p, 2)}</td></tr>`).join('') : '<tr><td colspan="3">正在计算</td></tr>';
  $('force-all-hit').textContent = percent(risk?.fixed_all_remaining_hit_probability);
  $('force-all-cost').textContent = money(risk?.fixed_all_remaining_cost);
  const tooMuch = risk && recommendation.remaining_budget != null && risk.fixed_all_remaining_cost > recommendation.remaining_budget + 1e-9;
  $('force-all-note').textContent = `该对照假定预算足够、把现场剩余${recommendation?.actual_remaining ?? '—'}件全部抽完且不停手，与上面的自适应策略不同。${tooMuch ? '当前硬预算不足以抽完；这不是本预算下可执行的计划。' : '此处成本为强制抽完的支出，不是策略的预计追加花费。'}`;
}

function mechanismDescription(mechanism) {
  if (mechanism.kind === 'random_removal') return '随机移除对照：入场剩余数由现场输入，组成按均匀子集假设；不推断真实前人的行为或残盒频率。';
  if (mechanism.kind === 'fixed_draws') return `固定抽数假设：前人从满盒固定抽${mechanism.draws}次后停手。`;
  const targets = mechanism.target_ids.map(id => { const item = itemById(id); return `${roleName(item)}·${editionLabel(item)}`; }).join('、');
  return `前人目标停手假设：从满盒开始，目标为${targets}；命中其中${mechanism.hit_limit}款或达到最多${mechanism.max_draws}抽即停。前人目标与我的目标独立，该行为尚待现场验证。`;
}

function renderMechanism() {
  $('mechanism-summary').textContent = mechanismDescription(current.config.mechanism);
  $('session-targets').textContent = `我的目标：${current.config.target_ids.map(id => { const item = itemById(id); return `${roleName(item)}·${editionLabel(item)}`; }).join('、')}。这些目标只用于命中风险统计。`;
  const stage = recommendation?.stage1;
  $('stage1-summary').innerHTML = !stage ? '<p class="hint">正在计算残盒条件分布。</p>' : stage.probability_n == null ? `<p class="hint">随机移除对照把入场N作为外部条件，无法由此推断“N=${current.config.initial_remaining}残盒”的出现频率、前人不入场或抽空概率。条件支持${stage.conditional_support}种入场组成。</p>` : `<div class="stage1-grid"><div><span>留下入场N=${current.config.initial_remaining}的概率</span><strong>${percent(stage.probability_n, 2)}</strong></div><div><span>前人未入场</span><strong>${percent(stage.no_entry_probability, 2)}</strong></div><div><span>前人最终抽空</span><strong>${percent(stage.empty_probability, 2)}</strong></div><div><span>终止时非空（含未入场）</span><strong>${percent(stage.nonempty_probability, 2)}</strong></div></div><p class="hint">以上为假设规则从满盒出发的无条件频率；下方决策已条件化于入场N和自己的观察，未隐去抽空或不入场。入场条件支持${stage.conditional_support}种组成。</p>`;
  $('model-assumptions').innerHTML = (recommendation?.assumptions || []).map(value => `<li>${esc(value)}</li>`).join('');
  $('method-name').textContent = recommendation ? `方法：${recommendation.method}。精确有限状态计算，无蒙特卡洛抽样误差；假设误差仍存在。` : '';
  const meta = current.config.valuation_meta;
  $('valuation-snapshot').textContent = meta.kind === 'five_levels' ? `本会话固定愿付尺度${num(meta.willingness)}元；五档权重${meta.weights.map(value => num(value)).join(' / ')}。单款估值可在14款明细查看。` : meta.kind === 'explicit_values' ? '本会话使用显式逐款估值；无可解释的五档标签，概率按角色显示。' : '本会话使用逐款个人参考价；目标由独立勾选确定。';
}

function renderComparison() {
  const comparison = recommendation?.comparison;
  $('comparison-panel').hidden = !comparison;
  if (!comparison) return;
  const baseline = comparison.baseline;
  const facts = [comparison.predictive_differs ? '逐款下一抽预测存在差异' : '逐款下一抽预测在数值容差内一致', comparison.action_disagrees ? '两个假设的经济动作不同' : '两个假设的经济动作一致'];
  $('comparison-note').textContent = `${facts.join('；')}。随机移除是另一个明确的假设，不是已证实的真实机制，也没有与前人目标停手按未知比例混合。行为规则未验证时，请保留条件性理解。`;
  const row = (label, advice) => `<tr><th>${esc(label)}</th><td>${advice.action === 'buy' ? '继续' : '停手'}</td><td>${percent(advice.risk.next_target_probability)}</td><td>${percent(advice.risk.remaining_zero_target_probability)}</td><td>${percent(advice.risk.policy_final_no_target_probability)}</td><td>${num(advice.risk.expected_additional_spend)}元</td></tr>`;
  $('comparison-rows').innerHTML = row('本次前人假设', recommendation) + row('随机移除对照', baseline);
  const range = (a, b) => `${percent(Math.min(a, b))}～${percent(Math.max(a, b))}`;
  $('comparison-range').textContent = `两个明确假设的下一抽目标概率范围：${range(recommendation.risk.next_target_probability, baseline.risk.next_target_probability)}；各自策略最终未中范围：${range(recommendation.risk.policy_final_no_target_probability, baseline.risk.policy_final_no_target_probability)}。这是情景范围，不是置信区间、保证范围或最坏情况界。`;
}

function renderLedger() {
  const active = activeEvents(current);
  $('record-count').textContent = `${active.length}抽`;
  $('event-list').innerHTML = current.events.length ? current.events.map((event, index) => {
    const item = itemById(event.item_id);
    const undone = event.status === 'undone';
    return `<div class="event-row${undone ? ' undone' : ''}"><span class="event-order">${String(index + 1).padStart(2, '0')}</span><div class="event-body"><strong>${esc(roleName(item))}</strong><small>${esc(editionLabel(item))} · ${undone ? '已撤销录入' : `${num(current.config.cost)}元`}</small></div>${undone ? '' : `<button type="button" class="undo-button" data-undo="${esc(event.event_id)}" aria-label="撤销录入 ${esc(roleName(item))} ${esc(editionLabel(item))}">撤销</button>`}</div>`;
  }).join('') : '<p class="empty-ledger">尚无自己的抽取记录。<br>无需先抽一件，也可以查看当前建议。</p>';
}

function populateDrawRoles() {
  const chosen = $('draw-role').value;
  const observed = new Set(activeEvents(current).map(event => event.item_id));
  $('draw-role').innerHTML = `<option value="">选择角色</option>${catalog.roles.map(role => `<option value="${esc(role.id)}"${chosen === role.id ? ' selected' : ''}${roleItems(role.id).every(item => observed.has(item.id)) ? ' disabled' : ''}>${esc(role.name)}</option>`).join('')}`;
  populateDrawEditions();
}

function populateDrawEditions() {
  const roleId = $('draw-role').value;
  const previous = $('draw-edition').value;
  const observed = new Set(current ? activeEvents(current).map(event => event.item_id) : []);
  $('draw-edition').innerHTML = roleId ? `<option value="">选择版本</option>${roleItems(roleId).map(item => `<option value="${esc(item.id)}"${previous === item.id ? ' selected' : ''}${observed.has(item.id) ? ' disabled' : ''}>${esc(editionLabel(item))}${observed.has(item.id) ? '（已记录）' : ''}</option>`).join('')}` : '<option value="">先选择角色</option>';
  $('draw-edition').disabled = !roleId;
  updateRecordAvailability();
}

function updateRecordAvailability() {
  if (!current) { $('record-button').disabled = true; return; }
  const info = recommendation || basicSnapshot();
  const noBudget = info.remaining_budget != null && info.remaining_budget + 1e-9 < current.config.cost;
  const empty = info.actual_remaining <= 0;
  const selected = $('draw-edition').value;
  const duplicate = activeEvents(current).some(event => event.item_id === selected);
  $('record-button').disabled = busy || empty || noBudget || !selected || duplicate;
  $('record-limit-note').textContent = empty ? '现场库存已空，不能再录入抽取。' : noBudget ? '配置的硬预算已不足单抽；可导出记录或建立新会话。' : '每款一份假设下，自己已经记录的同款不能再次抽到。';
}

function populateNewSessionFromCurrent() {
  if (!current) return;
  const config = current.config;
  document.querySelector(`input[name="valuation-mode"][value="${config.mode}"]`).checked = true;
  $('draw-cost').value = String(config.cost);
  $('budget').value = config.budget == null ? '' : String(config.budget);
  if (config.mode === 'preference') {
    const meta = config.valuation_meta || {};
    (meta.weights || DEFAULT_WEIGHTS).forEach((weight, index) => { $(`weight-${index}`).value = weight; });
    $('willingness').value = meta.willingness ?? 100;
    catalog.items.forEach(item => { $(`rating-${item.id}`).value = meta.ratings?.[item.id] ?? ''; });
    catalog.roles.forEach(role => {
      const pair = roleItems(role.id).map(item => $(`rating-${item.id}`).value);
      $(`role-rating-${role.id}`).value = pair.every(value => value === pair[0]) ? pair[0] : '';
    });
    const favoriteIds = catalog.items.filter(item => meta.ratings?.[item.id] === 0).map(item => item.id);
    const sameFavorites = favoriteIds.length === config.target_ids.length && favoriteIds.every(id => config.target_ids.includes(id));
    $('target-definition').value = sameFavorites ? 'favorite' : 'top_two';
  } else catalog.items.forEach(item => { $(`price-${item.id}`).value = config.values[item.id]; });
  catalog.items.forEach(item => { $(`price-target-${item.id}`).checked = config.target_ids.includes(item.id); });
  const mechanism = config.mechanism;
  $('mechanism-kind').value = mechanism.kind;
  catalog.items.forEach(item => { $(`predecessor-target-${item.id}`).checked = mechanism.target_ids?.includes(item.id) || false; });
  $('predecessor-hit-limit').value = mechanism.hit_limit ?? 1;
  $('predecessor-max-draws').value = mechanism.max_draws ?? 14;
  $('predecessor-fixed-draws').value = mechanism.draws ?? 0;
  updateMode();
  updateMechanismControls();
}

function wireEvents() {
  $('setup-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      const input = buildInput();
      const state = await call({ op: 'create', input }, catalog);
      await activate(state);
      $('result-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  $('refresh-advice').addEventListener('click', () => task(async () => {
    recommendation = await call({ op: 'recommend', state: current }, catalog);
    renderResult();
    success('建议已刷新，预算、库存和记录均未改变。');
  }));
  $('new-session').addEventListener('click', () => {
    if (busy) return;
    clearFeedback();
    populateNewSessionFromCurrent();
    displaySetup();
    $('setup-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('return-session').addEventListener('click', () => { if (!busy && current) { clearFeedback(); displayResult(); renderResult(); } });
  $('draw-role').addEventListener('change', () => { $('draw-edition').value = ''; populateDrawEditions(); });
  $('draw-edition').addEventListener('change', updateRecordAvailability);
  $('record-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      const itemId = $('draw-edition').value;
      if (!itemId) throw problem('请先选择真实抽到的角色与版本。', 'draw-role');
      if (!pendingRecord || pendingRecord.item_id !== itemId || pendingRecord.session_id !== current.session_id) pendingRecord = { item_id: itemId, session_id: current.session_id, event_id: globalThis.crypto?.randomUUID?.() || `draw-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      const state = await call({ op: 'record', state: current, event_id: pendingRecord.event_id, item_id: itemId }, catalog);
      $('draw-role').value = '';
      $('draw-edition').value = '';
      await activate(state);
      success('实际结果已记录，后验、剩余抽数与预算已更新。');
    });
  });
  $('event-list').addEventListener('click', event => {
    const button = event.target.closest('[data-undo]');
    if (!button) return;
    task(async () => {
      const state = await call({ op: 'undo', state: current, event_id: button.dataset.undo }, catalog);
      await activate(state);
      success('已撤销这条误录，原事件ID仍保留。请以新记录填写实际结果；这不代表实际退款。');
    });
  });
  $('restore-saved').addEventListener('click', () => task(async () => {
    const id = $('saved-session').value;
    if (!id || !store.sessions[id]) throw problem('请先选择一个已保存的会话。', 'saved-session');
    const state = await call({ op: 'restore', payload: store.sessions[id].state }, catalog);
    await activate(state, false);
    success('已恢复本机会话，使用该会话原有的固定估值与账本。');
  }));
  $('export-session').addEventListener('click', () => {
    if (busy || !current) return;
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ark54-v2-session-${current.session_id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('import-session').addEventListener('click', () => { if (!busy) $('import-file').click(); });
  $('import-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    task(async () => {
      if (file.size > 2_000_000) throw new Error('会话文件过大，请选择本工具导出的 JSON 会话。');
      const state = await call({ op: 'restore', payload: await file.text() }, catalog);
      await activate(state);
      success('JSON会话已导入并校验，保留原估值与记录。');
    }).finally(() => { event.target.value = ''; });
  });
}

async function initialize() {
  try {
    const response = await fetch('./data/box54.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取54.0产品配置。请通过本机启动入口访问，而不是直接双击HTML文件。');
    catalog = await response.json();
    if (catalog.box_id !== '54.0' || !Array.isArray(catalog.items) || catalog.items.length !== 14 || !Array.isArray(catalog.roles) || catalog.roles.length !== 7) throw new Error('54.0产品配置不完整，请检查目录版本；页面不会猜测库存。');
    const runtime = await getRuntime();
    $('runtime-label').textContent = runtime.compute === 'python' ? '本机 Python 计算' : '浏览器独立计算';
    document.documentElement.dataset.compute = runtime.compute;
    setupControls();
    wireEvents();
    readStore();
    updateSavedSelect();
    const sources = Array.isArray(catalog.sources) ? catalog.sources : [];
    $('source-links').innerHTML = sources.map(source => typeof source === 'string' ? { url: source, title: '产品来源' } : source).filter(source => /^https?:\/\//.test(source.url || '')).map(source => `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title || source.label || '产品资料来源')} ↗</a>`).join('');
    $('catalog-source').textContent = `目录版本 ${catalog.catalog_version}。名称与版本依据来源记录；“每款各一份”仍是待核实的测试假设。`;
    if (store.activeId && store.sessions[store.activeId]) {
      try {
        const restored = await call({ op: 'restore', payload: store.sessions[store.activeId].state }, catalog);
        await activate(restored, false);
      } catch (error) {
        current = null;
        displaySetup();
        showError(new Error(`原本机会话未能恢复，未自动改写旧记录。${error.message}`));
      }
    } else displaySetup();
  } catch (error) {
    $('loading-view').textContent = '初始化未完成。请确认使用README中的本机启动入口，且配置与脚本文件齐全。';
    showError(error);
  }
}

initialize();
