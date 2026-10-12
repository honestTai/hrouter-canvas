import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', path), 'utf8'));

// Claude Code only offers an update when the plugin version changes, so it must track npm.
test('plugin manifests carry the package version', () => {
  const { version, name } = read('package.json');
  assert.equal(read('.claude-plugin/plugin.json').version, version);
  assert.deepEqual(read('.mcp.json').mcpServers['hrouter-canvas'].args, ['-y', `${name}@latest`]);
});
