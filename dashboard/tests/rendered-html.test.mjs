import assert from 'node:assert/strict';
import test from 'node:test';

test('server renders the focused NUSNextBus signal dashboard', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const response = await worker.fetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }), { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Live channels/);
  assert.match(html, /NUSNextBus/);
  assert.match(html, /LLM Agent: Thinking/);
  assert.match(html, /App booking signal/);
  assert.match(html, /Sense: CV-Based Live Detection/);
  assert.match(html, /Bus digital twin/);
  assert.match(html, /Validated action plan/);
  assert.match(html, /Preview boarding/);
  assert.match(html, /YOLO/);
  assert.match(html, /<html lang="en"/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|Run simulated agent/);
  assert.doesNotMatch(html, /Signal server connected|Signals → reasoning → validated plan|word-by-word live reveal|YOLO region monitor|Simulated bus response/);
});
