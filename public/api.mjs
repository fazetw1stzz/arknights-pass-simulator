const MODEL_VERSION = 'residual-items-v2';
let runtimePromise;
let clientModule;
function apiError(error, fallback) {
  const result = new Error(error?.message || fallback);
  result.code = error?.code || 'API_ERROR';
  return result;
}
export async function getRuntime() {
  if (!runtimePromise) runtimePromise = (async () => {
    let response;
    try { response = await fetch('./runtime-config.json', { cache: 'no-store' }); }
    catch (_) { throw apiError({ code: 'RUNTIME_UNAVAILABLE' }, '无法读取计算配置，请通过本地HTTP启动，并确认服务窗口仍在运行。'); }
    if (!response.ok) throw apiError({ code: 'RUNTIME_UNAVAILABLE' }, '无法读取计算配置；不会自动切换其他模型。');
    const config = await response.json();
    if (!['python', 'client'].includes(config.compute) || config.api_version !== 2 || config.model_version !== MODEL_VERSION)
      throw apiError({ code: 'RUNTIME_VERSION_MISMATCH' }, '页面与计算配置版本不一致，请刷新或完整解压当前版本。');
    return config;
  })();
  return runtimePromise;
}
export async function call(request, catalog) {
  const runtime = await getRuntime();
  if (runtime.compute === 'python') {
    let response;
    try { response = await fetch('./api/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); }
    catch (_) { throw apiError(null, '本机计算服务暂时不可用。请确认启动窗口仍在运行后重试；本次未更新记录。'); }
    let body;
    try { body = await response.json(); }
    catch (_) { throw apiError(null, '计算服务没有返回有效JSON，本次未更新记录。'); }
    if (!response.ok || body.ok !== true) throw apiError(body.error, `计算请求失败（HTTP ${response.status}）`);
    if (body.result?.model_version !== MODEL_VERSION) throw apiError({ code: 'RUNTIME_VERSION_MISMATCH' }, '计算服务返回了不同模型版本，本次未更新记录。');
    return body.result;
  }
  if (!clientModule) clientModule = import('./model.mjs');
  const engine = await clientModule;
  if (engine.MODEL_VERSION !== MODEL_VERSION) throw apiError({ code: 'RUNTIME_VERSION_MISMATCH' }, '浏览器计算模块版本不一致。');
  return engine.dispatch(request, catalog);
}
