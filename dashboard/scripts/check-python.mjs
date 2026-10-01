import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
const python = process.env.PYTHON_EXECUTABLE || 'python';
const child = spawn(python, ['integrations/demo_signals.py', '--mode', 'rules', '--seconds', '4'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
let live, channels;
for (let i = 0; i < 30; i++) {
  await new Promise(resolve => setTimeout(resolve, 150));
  const snapshot = await (await fetch('http://127.0.0.1:8787/api/state')).json();
  if (snapshot.source === 'external' && snapshot.channels.booking && snapshot.channels.perception && snapshot.result?.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP')) { live = snapshot.result; channels = Object.keys(snapshot.channels).sort(); break; }
}
assert.ok(live, 'App + YOLO should create a ramp demonstration without a vehicle signal');
assert.deepEqual(channels, ['booking', 'perception']);
assert.equal(live.vehicle_context_source, 'SIMULATED_SCENARIO');
assert.equal(await exit, 0, log);
await new Promise(resolve => setTimeout(resolve, 2200));
const retained = await (await fetch('http://127.0.0.1:8787/api/state')).json();
assert.equal(retained.result?.request_id, live.request_id, 'The same demo result stays on screen without repeated API calls');
await mkdir('outputs', { recursive: true });
const report = { pythonSignalChain: 'passed', channels, vehicleSource: live.vehicle_context_source, apiCalls: live.meta.api_calls, status: live.plan_status, snapshotRetained: true };
await writeFile('outputs/python-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
