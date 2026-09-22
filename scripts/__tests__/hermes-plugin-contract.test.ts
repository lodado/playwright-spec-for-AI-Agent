import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEphemeralHermesBrowserTools } from '../hermes-runner.mjs';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
it.skipIf(!pythonAvailable)('exposes native function parameters and accepts Hermes dispatch kwargs', () => {
  const script = `import json, sys
scope = {}
exec(sys.stdin.read(), scope)
tools = {}
class Context:
    def register_tool(self, **tool): tools[tool['name']] = tool
scope['register'](Context())
scope['_post'] = lambda payload: payload
assert set(tools) == {'qa_checkpoint', 'qa_upload_fixture'}
for name, tool in tools.items():
    schema = tool['schema']
    assert schema['name'] == name
    assert schema['parameters']['type'] == 'object'
    assert set(schema['parameters']['required']) >= {'checkId', 'url'}
    result = tool['handler']({'checkId': 'chk_one', 'url': 'http://localhost', 'fixture': 'upload'}, task_id='t', session_id='s', user_task='task')
    assert isinstance(result, str)
    result = json.loads(result)
    assert result['checkId'] == 'chk_one'
    assert result['action'] in ('capture', 'upload')
print('native schema and dispatch contract passed')
`;
  const home = mkdtempSync(join(tmpdir(), 'qa-plugin-contract-'));
  installEphemeralHermesBrowserTools(home, { url: 'http://127.0.0.1:1234/', token: 'test-token' });
  const source = readFileSync(join(home, 'plugins/qa_browser_tools/__init__.py'), 'utf8');
  const result = spawnSync('python3', ['-c', script], { input: source, encoding: 'utf8' });
  rmSync(home, { recursive: true, force: true });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('native schema and dispatch contract passed');
});
