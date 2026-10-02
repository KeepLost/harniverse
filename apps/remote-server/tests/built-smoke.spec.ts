import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const artifact = process.env.DSH_REMOTE_ARTIFACT
const exec = promisify(execFile)

it.skipIf(artifact === undefined)('boots the deployed closure with plain Node, retains unlock after HTTP disconnect, and restarts locked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-built-smoke-'))
  const directory = resolve(artifact!)
  try {
    const { stdout } = await exec(join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), ['--input-type=module', '-e', `
      import 'node-addon-require-builtin';
      import assert from 'node:assert/strict';
      import { randomBytes } from 'node:crypto';
      import { readFile } from 'node:fs/promises';
      import { get } from 'node:http';
      import { join } from 'node:path';
      import { Session, SessionId } from '@deepseek-ai/dsh-session';
      import { runRemoteServer } from './lib/index.js';
      const session = Session.create(SessionId('remote-built-smoke'));
      const first = await runRemoteServer();
      let bootId;
      try {
        const status = first.remoteRuntime.status();
        assert.equal(status.locked, true);
        bootId = status.bootId;
        assert.throws(() => first.agents.assertAdmission(session), /locked/);
        const key = randomBytes(32).toString('base64url');
        await first.remoteRuntime.unlock(key);
        await first.remoteRuntime.replaceCredentials({ SMOKE_KEY: 'ephemeral-smoke-value' });
        const endpoint = JSON.parse(await readFile(join(process.env.DSH_HOME, 'server/endpoint.json'), 'utf8'));
        assert.equal(endpoint.bootId, bootId);
        assert.equal(endpoint.host, '127.0.0.1');
        const auth = await new Promise((resolve, reject) => {
          get('http://127.0.0.1:' + endpoint.port + '/auth/status', { agent: false }, response => {
            let body = ''; response.on('data', chunk => { body += chunk });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
          }).on('error', reject);
        });
        assert.equal(auth.status, 200);
        assert.equal(auth.body.mode, 'authenticated');
        assert.equal(first.remoteRuntime.status().locked, false);
        assert.doesNotThrow(() => first.agents.assertAdmission(session));
        assert.equal((await first.credentials.resolve('SMOKE_KEY')).value, 'ephemeral-smoke-value');
      } finally { await first.fiber.dispose(); }
      const second = await runRemoteServer();
      try {
        assert.equal(second.remoteRuntime.status().locked, true);
        assert.throws(() => second.agents.assertAdmission(session), /locked/);
        assert.notEqual(second.remoteRuntime.status().bootId, bootId);
        console.log('REMOTE_BUILT_SMOKE_OK');
      } finally { await second.fiber.dispose(); }
    `], {
      cwd: join(directory, 'app'), timeout: 60_000,
      env: { ...process.env, DSH_HOME: home, NODE_OPTIONS: '', NODE_PATH: '' },
      maxBuffer: 1024 * 1024,
    })
    expect(stdout).toContain('REMOTE_BUILT_SMOKE_OK')
  } finally { await rm(home, { recursive: true, force: true }) }
}, 65_000)
