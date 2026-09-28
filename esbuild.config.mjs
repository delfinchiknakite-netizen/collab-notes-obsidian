import esbuild from 'esbuild';
import builtins from 'builtin-modules';

const prod = process.argv.includes('production');
await esbuild.build({
  entryPoints: ['main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'browser',
  external: [
    'obsidian', 'electron',
    '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
    '@codemirror/language', '@codemirror/lint', '@codemirror/search',
    '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
    ...builtins,
  ],
  outfile: 'main.js',
  sourcemap: false,
  minify: prod,
  logLevel: 'info',
});
console.log('built main.js');
