import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(process.env.BRIDGE_STARTUP_TEST_SOURCE || new URL('../bridge/bridge.js', import.meta.url), 'utf8');
const accounts = source.slice(source.indexOf('function verifyBoundWechatAccount'), source.indexOf('function buildMuseText'));
const entrypoint = source.slice(source.indexOf('async function main()'), source.lastIndexOf('main();'));

async function start(storedUser) {
  const calls = [];
  const config = {ilink_user_id: 'family'};
  const scope = vm.createContext({
    config, path, fs: {unlinkSync() {}}, PID_PATH: '/isolated/bridge.pid', secrets: [],
    process: {argv: [], env: {}, on() {}, exit() {throw new Error('unexpected process exit');}},
    openDb() {}, loadConfig: () => config, acquireSingleInstance: () => true,
    log() {}, redact: String,
    sdkAccounts: {
      listWeixinAccountIds: () => ['family-bot'], normalizeAccountId: String,
      // Match the real SDK: the resolved runtime account has no userId.
      resolveWeixinAccount: accountId => ({accountId, configured: true, token: 'test-token'}),
      loadWeixinAccount: () => ({userId: storedUser}),
    },
    recoverOnStartup: async () => calls.push('recover'),
    warmupMuse: async () => calls.push('warmup'),
    startReminderScheduler: account => calls.push(`scheduler:${account.accountId}`),
    stopReminderScheduler: () => calls.push('scheduler-stopped'),
    mainLoop: async account => calls.push(account.accountId),
  });
  vm.runInContext(accounts, scope);
  vm.runInContext(entrypoint, scope);
  await scope.main();
  return {calls, exitCode: scope.process.exitCode};
}

test('real startup reaches warmup and polling with matching persisted scanner and SDK runtime account', async () => {
  const result = await start('family');
  assert.deepEqual(result.calls, ['recover', 'warmup', 'scheduler:family-bot', 'family-bot', 'scheduler-stopped']);
  assert.equal(result.exitCode, undefined);
});

test('real startup rejects a different or missing persisted scanner before warmup and polling', async () => {
  for (const storedUser of ['owner', undefined]) {
    const result = await start(storedUser);
    assert.deepEqual(result.calls, []);
    assert.equal(result.exitCode, 1);
  }
});

