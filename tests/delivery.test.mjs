import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
const source = fs.readFileSync(new URL('../bridge/bridge.js',import.meta.url),'utf8');
const dbCode = source.slice(source.indexOf('function openDb'),source.indexOf('// 附件媒体处理'));
const replyCode = source.slice(source.indexOf('function cleanReplyForWechat'),source.indexOf('/** 通知类短消息'));
const taskCode = source.slice(source.indexOf('async function runTaskInner'),source.indexOf('async function handleMessage'));
function harness(reply,files,onFile = async () => {},onText = async () => 'sent',splitText = text => [text]) {
  const notices = [];
  const scope = vm.createContext({
    db: undefined, DatabaseSync, DB_PATH:':memory:', fs:{existsSync:() => true,chmodSync:() => {},mkdirSync:() => {}},
    MEDIA_DIR:'/tmp/fake-media',
    log:() => {}, redact:String, path, stopping:false,
    config:{muse_cli_path:'mock'}, markerFor:id => `任务${id}回复完毕。`,
    buildMuseText:text => text, getMaxSeq:async () => 1,
    execFileAsync:async () => ({stdout:'{"stream":1}'}),
    waitForReply:async () => ({text:reply,via:'marker'}),
    extractReturnedFilePath:() => files, isNetworkError:() => false,
    sendMediaReply:onFile, sendOnce:onText, sleep:async () => {}, splitText,
    sendNotice:async (_account,_row,text) => {notices.push(text); return 'sent';},
  });
  vm.runInContext(dbCode + '\n' + replyCode + '\n' + taskCode,scope);
  scope.openDb();
  scope.db.prepare('INSERT INTO tasks(message_id,status,text,from_user_id,context_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('test','received','生成文件','fake-user','fake-context',0,0);
  return {scope,notices,row:() => scope.db.prepare('SELECT * FROM tasks WHERE message_id = ?').get('test')};
}
test('two accepted attachments plus empty text finish sent with actual per-file receipts', async () => {
  const files = ['/task/one.png','/task/two.png'];
  const {scope,row} = harness(files.map(p => '生成文件：'+p).join('\n'),files);
  await scope.runTaskInner('test',{},new AbortController().signal);
  assert.equal(row().status,'sent'); assert.equal(row().send_receipt,'sent');
  assert.deepEqual(JSON.parse(row().file_send_results).map(r => r.status),['ok','ok']);
  scope.db.close();
});
test('an attachment rejection finishes failed even when user text succeeds', async () => {
  const {scope,row,notices} = harness('已发给你。\n生成文件：/task/file.png',['/task/file.png'],async () => {throw new Error('rejected');});
  await scope.runTaskInner('test',{},new AbortController().signal);
  assert.equal(row().status,'failed'); assert.equal(row().send_receipt,'failed');
  assert.equal(JSON.parse(row().file_send_results)[0].status,'failed');
  assert.match(notices[0],/未能发出/); scope.db.close();
});
test('empty reply with no attachment is unknown, not a successful delivery', async () => {
  const {scope,row} = harness('',[]);
  await scope.runTaskInner('test',{},new AbortController().signal);
  assert.equal(row().status,'unknown'); assert.equal(row().send_receipt,'unknown');
  scope.db.close();
});
test('a late accepted text segment records its receipt without overwriting timeout', async () => {
  const controller = new AbortController();
  let release, started;
  const gate = new Promise(resolve => {release=resolve;});
  const entered = new Promise(resolve => {started=resolve;});
  let count=0;
  const {scope,row} = harness('正文',[],undefined,async () => {count++; started(); await gate; return 'sent';},() => ['第一段','第二段']);
  const pending = scope.runTaskInner('test',{},controller.signal);
  await entered;
  scope.setStatusIfNotFinal('test','timeout'); controller.abort(); release();
  await pending;
  assert.equal(count,1); assert.equal(row().status,'timeout');
  assert.equal(row().send_receipt,'partial');
  assert.equal(JSON.parse(row().text_send_results)[0].status,'sent');
  scope.db.close();
});

test('cancellation during baseline lookup prevents Muse submission and preserves timeout', async () => {
  const controller = new AbortController();
  const {scope,row,notices} = harness('正文',[]);
  let submits=0;
  scope.execFileAsync=async () => {submits++; return {stdout:'{"stream":1}'};};
  scope.getMaxSeq=async signal => {
    assert.equal(signal,controller.signal);
    scope.setStatusIfNotFinal('test','timeout'); controller.abort(); return 1;
  };
  await scope.runTaskInner('test',{},controller.signal);
  assert.equal(submits,0); assert.equal(row().status,'timeout'); assert.equal(notices.length,0);
  scope.db.close();
});

test('a cancelled media failure sends no extra failure notice and cannot overwrite timeout', async () => {
  const controller = new AbortController();
  const {scope,row,notices} = harness('视频',[]);
  scope.MEDIA_DIR='/task';
  scope.db.prepare('UPDATE tasks SET media_type=5, media_status=?, media_path=?, media_info=? WHERE message_id=?')
    .run('downloaded','["/task/video.mp4"]','[]','test');
  scope.extractVideoFrames=async () => {
    scope.setStatusIfNotFinal('test','timeout'); controller.abort(); throw new Error('aborted subprocess');
  };
  await scope.runTaskInner('test',{},controller.signal);
  assert.equal(row().status,'timeout'); assert.equal(notices.length,0);
  scope.db.close();
});

test('a cancelled Muse subprocess cannot turn timeout into failed', async () => {
  const controller = new AbortController();
  const {scope,row} = harness('正文',[]);
  scope.execFileAsync=async () => {
    scope.setStatusIfNotFinal('test','timeout'); controller.abort(); throw new Error('subprocess cancelled');
  };
  await scope.runTaskInner('test',{},controller.signal);
  scope.setFailed('test','late error');
  assert.equal(row().status,'timeout'); scope.db.close();
});

test('late accepted attachment retains its actual receipt and skips later attachments and text', async () => {
  const controller = new AbortController();
  let calls=0;
  const {scope,row}=harness('完成',['/task/one.png','/task/two.png'],async () => {
    calls++; scope.setStatusIfNotFinal('test','timeout'); controller.abort();
  });
  await scope.runTaskInner('test',{},controller.signal);
  assert.equal(calls,1); assert.equal(row().status,'timeout');
  assert.deepEqual(JSON.parse(row().file_send_results).map(result => result.status),['ok']);
  assert.equal(row().text_send_results,null); scope.db.close();
});

test('total deadline records timeout and one notice without another history lookup', async () => {
  const {scope,row,notices}=harness('正文',[]);
  scope.setTimeout=setTimeout; scope.clearTimeout=clearTimeout; scope.AbortController=AbortController;
  scope.config.task_total_timeout_ms=15;
  let queries=0; scope.getMaxSeq=async () => {queries++; throw new Error('history unavailable');};
  scope.runTaskInner=async () => {scope.setStatus('test','running'); await new Promise(() => {});};
  vm.runInContext(source.slice(source.indexOf('async function runTask(id'),source.indexOf('async function runTaskInner')),scope);
  await scope.runTask('test',{});
  assert.equal(row().status,'timeout'); assert.equal(notices.length,1); assert.equal(queries,0);
  scope.db.close();
});
