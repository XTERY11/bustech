import assert from 'node:assert/strict';
import test from 'node:test';

test('server renders the actual AccessRide signal dashboard', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const response = await worker.fetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }), { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /AccessRide Prompt Lab/);
  assert.match(html, /Thinking/);
  assert.match(html, /Action/);
  assert.match(html, /YOLO/);
  assert.match(html, /<html lang="en"/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|Run simulated agent/);
});
