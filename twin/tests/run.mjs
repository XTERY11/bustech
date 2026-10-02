import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'b70a02-tests-'));
try {
  const outfile = join(directory, 'cabin.test.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('./cabin.test.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
