import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { build as bundle } from 'esbuild';
import { build as buildWeb } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

// One self-contained file: `npx` starts fast and there is nothing to install at runtime.
await bundle({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync('dist/cli.mjs', 0o755);
await buildWeb({ configFile: 'web/vite.config.ts', logLevel: 'warn' });
console.log(`built hrouter-canvas-mcp ${version}`);
