import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// 回归测试：纯文本任务在调用 Muse 前必须建好自己的 output dir，
// 且文本/附件两套提示词都必须写明 task 专属保存目录 + 生成文件标记。
const source = fs.readFileSync(new URL('../bridge/bridge.js', import.meta.url), 'utf8');

function loadPromptFns(mediaDir) {
  const textFn = source.slice(source.indexOf('function buildMuseText'), source.indexOf('function stripMarker'));
  const mediaFn = source.slice(source.indexOf('function buildMediaPrompt'), source.indexOf('/**\n * 验证路径在任务目录内'));
  const scope = vm.createContext({
    path,
    MEDIA_DIR: mediaDir,
    MEDIA_TYPE_LABEL: {},
    markerFor: id => `任务${id}回复完毕。`,
  });
  vm.runInContext(textFn + '\n' + mediaFn, scope);
  return scope;
}

test('buildMuseText 明确 task 专属保存目录与生成文件标记', () => {
  const mediaDir = path.join('tmp', 'fake-bridge', 'media');
  const scope = loadPromptFns(mediaDir);
  const wantDir = path.join(mediaDir, 'task123');
  const prompt = scope.buildMuseText('hello', 'task123');
  assert.ok(prompt.includes(wantDir), '应包含 task 专属目录');
  assert.ok(prompt.includes('生成文件：'), '应包含生成文件标记');
  assert.ok(prompt.includes('不要存到其他目录'), '应警告不要存别处');
});

test('buildMediaPrompt 明确 task 专属保存目录与生成文件标记', () => {
  const mediaDir = path.join('tmp', 'fake-bridge', 'media');
  const scope = loadPromptFns(mediaDir);
  const wantDir = path.join(mediaDir, 'task456');
  const prompt = scope.buildMediaPrompt([], 'hi', 'task456');
  assert.ok(prompt.includes(wantDir), '应包含 task 专属目录');
  assert.ok(prompt.includes('生成文件：'), '应包含生成文件标记');
  assert.ok(prompt.includes('不要存到其他目录'), '应警告不要存别处');
});

test('纯文本任务：getMaxSeq/execFileAsync 调用前 task 目录已存在且 prompt 含该目录', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdir-test-'));
  const mediaDir = path.join(tmpRoot, 'media');
  const taskId = 'beh123';
  const wantDir = path.join(mediaDir, taskId);
  const events = [];

  const dbCode = source.slice(source.indexOf('function openDb'), source.indexOf('// 附件媒体处理'));
  const taskCode = source.slice(source.indexOf('async function runTaskInner'), source.indexOf('async function handleMessage'));
  const scope = vm.createContext({
    db: undefined, DatabaseSync, DB_PATH: ':memory:',
    fs, // 真实 fs，写真实临时目录
    MEDIA_DIR: mediaDir,
    log: () => {}, redact: String, path, stopping: false,
    config: { muse_cli_path: 'mock-muse-cli' },
    markerFor: id => `任务${id}回复完毕。`,
    buildMuseText: undefined, // 让 runTaskInner 用源码内真实的 buildMuseText
    getMaxSeq: async () => {
      events.push('getMaxSeq');
      assert.ok(fs.existsSync(wantDir), 'getMaxSeq 调用前 task 目录应已存在');
      return 1;
    },
    execFileAsync: async (bin, args) => {
      events.push('execFileAsync');
      assert.ok(fs.existsSync(wantDir), 'execFileAsync 调用前 task 目录应已存在');
      const prompt = args.join('\n');
      assert.ok(prompt.includes(wantDir), 'Muse 请求应包含 task 专属目录');
      return { stdout: '{"stream":1}' };
    },
    waitForReply: async () => ({ text: 'ok\n任务beh123回复完毕。', via: 'marker' }),
    extractReturnedFilePath: () => [],
    isNetworkError: () => false,
    sendMediaReply: async () => {},
    sendOnce: async () => 'sent',
    sleep: async () => {},
    splitText: text => [text],
    sendNotice: async () => 'sent',
  });
  // 注入源码真实的 buildMuseText（markerFor 用等价 mock，避免引入 BRIDGE_DIR 等无关依赖）
  const promptFns = source.slice(source.indexOf('function buildMuseText'), source.indexOf('function stripMarker'));
  const sendFn = source.slice(source.indexOf('async function sendReply'), source.indexOf('/** 通知类短消息'));
  const cleanFn = source.slice(source.indexOf('function cleanReplyForWechat'), source.indexOf('/**\n * 发送文字回复'));
  const outcomeCode = source.slice(source.indexOf('function deliveryOutcome'), source.indexOf('async function sendReply'));
  const scopeMarkerFor = id => `任务${id}回复完毕。`;
  vm.runInContext(
    'const markerFor = ' + scopeMarkerFor.toString() + ';\n' + promptFns + '\n' + dbCode + '\n' + cleanFn + '\n' + outcomeCode + '\n' + sendFn + '\n' + taskCode,
    scope);
  scope.openDb();
  scope.db.prepare(
    'INSERT INTO tasks(message_id,status,text,from_user_id,context_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(taskId, 'received', 'hello', 'fake-user', 'fake-context', 0, 0);

  await scope.runTaskInner(taskId, {}, new AbortController().signal);

  assert.deepEqual(events, ['getMaxSeq', 'execFileAsync']);
  assert.equal(scope.db.prepare('SELECT status FROM tasks WHERE message_id = ?').get(taskId).status, 'sent');
  assert.ok(fs.existsSync(wantDir), '任务结束后目录应存在');
  scope.db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
