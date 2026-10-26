import assert from 'node:assert/strict';
import test from 'node:test';

const model = 'residual-items-v2';
let nonce = 0;
async function provider(fetch) {
  globalThis.fetch = fetch;
  return import(new URL(`../public/api.mjs?transport-case=${nonce++}`, import.meta.url));
}
const config = { compute: 'python', api_version: 2, model_version: model };
test('a missing runtime configuration fails without changing compute provider', async () => {
  const api = await provider(async () => { throw new Error('offline'); });
  await assert.rejects(api.getRuntime(), e => e.code === 'RUNTIME_UNAVAILABLE');
});
test('an old runtime version is not accepted as v2', async () => {
  const api = await provider(async () => ({ ok: true, json: async () => ({...config,model_version:'random-removal-items-v1'}) }));
  await assert.rejects(api.getRuntime(), e => e.code === 'RUNTIME_VERSION_MISMATCH');
});
test('a backend returning a different model fails without changing the request', async () => {
  const request = { op:'restore',payload:{schema_version:2} }, before=JSON.stringify(request);
  const api = await provider(async url => ({ok:true,json:async()=>String(url).includes('runtime-config')?config:{ok:true,result:{model_version:'random-removal-items-v1'}}}));
  await assert.rejects(api.call(request,{}), e=>e.code==='RUNTIME_VERSION_MISMATCH');
  assert.equal(JSON.stringify(request),before);
});
test('backend failure is reported and never silently recomputed with another model', async () => {
  let requests=0;
  const api = await provider(async url => {
    if(String(url).includes('runtime-config'))return {ok:true,json:async()=>config};
    requests++;throw new Error('offline');
  });
  await assert.rejects(api.call({op:'recommend'},{}), e=>e.code==='API_ERROR');
  assert.equal(requests,1);
});
