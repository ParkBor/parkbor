const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run(pathname) {
  const { default: worker } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'worker', 'index.js')));
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => (seen.push(new URL(req.url).pathname), new Response('ok')) } };
  await worker.fetch(new Request(`https://parkbor.uz${pathname}`), env);
  return seen;
}

test('every /b/<id> serves the helper page; other paths pass through', async () => {
  assert.deepStrictEqual(await run('/b/123e4567-e89b-12d3-a456-426614174000'), ['/b/']);
  assert.deepStrictEqual(await run('/b/anything/else'), ['/b/']);
  assert.deepStrictEqual(await run('/b/'), ['/b/']);
  assert.deepStrictEqual(await run('/ru/privacy/'), ['/ru/privacy/']);
});
