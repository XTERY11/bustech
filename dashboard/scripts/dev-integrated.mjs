import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createBridge } from '../backend/server.mjs';

async function readSecret(label) {
  console.log(`${label} input (hidden, kept in memory only):`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const rl = createInterface({ input: process.stdin, terminal: false });
  const secret = await new Promise((resolve, reject) => {
    let received = false;
    rl.once('line', line => { received = true; rl.close(); process.stdin.pause(); resolve(line.trim()); });
    rl.once('close', () => { if (!received) reject(new Error('Missing key input')); });
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  return secret;
}

if (process.argv.includes('--key-stdin')) process.env.DEEPSEEK_API_KEY = await readSecret('DeepSeek key');
const host = process.env.BRIDGE_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.BRIDGE_TOKEN) throw new Error('Set BRIDGE_TOKEN before enabling LAN access.');
const port = Number(process.env.BRIDGE_PORT || 8787);
const dashboardPort = Number(process.env.DASHBOARD_PORT || 3000);
const bridge = createBridge();
bridge.listen(port, host, () => console.log(`Signal bridge: http://${host}:${port}`));
// The API key stays in the hub process, never in the browser development process.
const webEnvironment = { ...process.env }; delete webEnvironment.DEEPSEEK_API_KEY;
const webArgs = ['node_modules/next/dist/bin/next', 'dev', ...(process.env.NEXT_DEV_BUNDLER === 'webpack' ? ['--webpack'] : []), '--hostname', process.env.DASHBOARD_HOST || host, '--port', String(dashboardPort)];
const web = process.argv.includes('--bridge-only') ? null : spawn(process.execPath, webArgs, { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'], env: webEnvironment });
const stop = () => { web?.kill(); bridge.closeAllConnections(); bridge.close(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
web?.on('exit', code => { bridge.closeAllConnections(); bridge.close(); process.exitCode = code || 0; });
bridge.on('error', () => { console.error(`Signal bridge could not start. Check port ${port}.`); stop(); process.exitCode = 1; });
