import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['sync-core.ts'], outfile: 'test/generated/sync-core.mjs', platform: 'node', format: 'esm', bundle: true, external: ['yjs'], target: 'node20' });
await build({ entryPoints: ['doc-cache.ts'], outfile: 'test/generated/doc-cache.mjs', platform: 'node', format: 'esm', bundle: true, external: ['yjs', 'obsidian'], target: 'node20' });
const result = spawnSync(process.execPath, ['--test', 'test/sync.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
