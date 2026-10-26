/** Pure display helpers. Probabilities and policy decisions come from the engine. */
export const PREFERENCE_LABELS = ['我推!!', '不错', '能接受', '无感', '不喜欢'];
const PREFERENCE_COLORS = ['#bf5839', '#68804f', '#8b9d78', '#aeb5a6', '#9c8b83'];
const EPS = 1e-9;
// Match the engine's numerical tolerance; do not hide materially invalid values.
const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= -EPS && value <= 1 + EPS;
const clampProbability = value => Math.max(0, Math.min(1, value));

export function hasCompleteRatings(catalog, valuationMeta) {
  const ratings = valuationMeta && typeof valuationMeta === 'object' && !Array.isArray(valuationMeta)
    && valuationMeta.kind === 'five_levels' ? valuationMeta.ratings : null;
  return Boolean(ratings && typeof ratings === 'object' && !Array.isArray(ratings)
    && Array.isArray(catalog.items) && catalog.items.length > 0
    && catalog.items.every(item => Object.hasOwn(ratings, item.id)
      && Number.isInteger(ratings[item.id]) && ratings[item.id] >= 0 && ratings[item.id] <= 4));
}

export function buildProbabilityGroups(catalog, probabilities, mode, valuationMeta) {
  const byId = new Map();
  for (const row of probabilities) {
    if (!isProbability(row.p)) throw new Error('模型返回的概率无效，无法展示分布。');
    byId.set(row.item_id, { ...row, p: clampProbability(row.p) });
  }
  const summarize = (items, label, color) => {
    const rows = items.map(item => byId.get(item.id)).filter(Boolean);
    return { label, color, p: rows.reduce((sum, row) => sum + row.p, 0), count: rows.filter(row => row.p > EPS).length };
  };
  if (mode === 'preference' && hasCompleteRatings(catalog, valuationMeta)) {
    return {
      basis: 'tiers',
      title: '下一抽的喜好档位',
      note: '',
      groups: PREFERENCE_LABELS.map((label, index) => summarize(
        catalog.items.filter(item => valuationMeta.ratings[item.id] === index), label, PREFERENCE_COLORS[index])),
    };
  }
  const roleIds = new Set(catalog.roles.map(role => role.id));
  const groups = catalog.roles.map(role => summarize(
    catalog.items.filter(item => item.role_id === role.id), role.name, '#68804f'));
  // A configuration error must not silently drop a known item's probability.
  for (const item of catalog.items.filter(item => !roleIds.has(item.role_id))) {
    groups.push(summarize([item], item.role_name || item.id, '#68804f'));
  }
  return {
    basis: 'roles',
    title: '下一抽的角色概率',
    note: mode === 'preference' ? '档位信息不可用：以下按角色显示真实概率，不推测或补填喜好档位。' : '',
    groups,
  };
}

/** Invalid or unavailable probabilities are not converted to zero. */
export function percent(value, digits = 1) {
  if (!isProbability(value)) return '—';
  const places = Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 1;
  return `${(clampProbability(value) * 100).toLocaleString('zh-CN', { minimumFractionDigits: places, maximumFractionDigits: places })}%`;
}

/** The engine's economic action stays separate from uncertainty in its assumptions. */
export function summarizeAdviceDisplay(advice) {
  if (!advice || !['buy', 'stop'].includes(advice.action)) {
    return { tone: 'amber', title: '尚未获得可核验建议', notes: ['请先完成计算，再根据具体概率和假设判断。'] };
  }
  const notes = [];
  const comparison = advice.comparison;
  const targetProbability = advice.risk?.next_target_probability;
  if (comparison?.unverified_behavior === true) notes.push('前人的停手行为尚未核实；当前结果只在所选前人规则假设下成立。');
  if (comparison?.predictive_differs === true) notes.push('所选前人规则与随机移除对照产生不同的预测概率，请同时查看两组结果。');
  if (comparison?.action_disagrees === true) notes.push('两种机制给出的抽／停结论不同；当前建议依赖前人行为假设。');
  if (!isProbability(targetProbability)) notes.push('目标命中概率不可用，不能据此作确定建议。');
  else if (targetProbability <= EPS) notes.push('在当前信念下，下一抽命中所选目标的概率为零；正的平均效用也不代表能抽到目标。');
  if (notes.length) {
    notes.unshift(advice.action === 'buy' ? '当前假设下的经济计算为继续；仍需单独判断以下风险。' : '当前假设下的经济计算为停手。');
    return { tone: 'amber', title: '先核对假设与目标风险', notes };
  }
  return advice.action === 'buy'
    ? { tone: 'positive', title: '当前假设下可考虑继续抽', notes: ['请结合未命中概率、追加花费和净效用分布判断；期望值不是结果保证。'] }
    : { tone: 'stop', title: '当前假设下建议停手', notes: ['抽／停结论来自当前固定估值、预算和信念策略，不代表目标一定不在盒内。'] };
}
