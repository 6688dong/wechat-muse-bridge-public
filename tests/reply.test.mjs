import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = fs.readFileSync(new URL('../bridge/bridge.js', import.meta.url), 'utf8');
const clean = source.slice(source.indexOf('function cleanReplyForWechat'), source.indexOf('/**\n * 发送文字回复'));
const send = source.slice(source.indexOf('async function sendReply'), source.indexOf('/** 通知类短消息'));
const outcomeCode = source.slice(source.indexOf('function deliveryOutcome'), source.indexOf('async function sendReply'));
function harness(sendOnce, splitText = text => [text]) {
  const records = [];
  const scope = vm.createContext({
    markerFor: id => `任务${id}回复完毕。`, extractReturnedFilePath: () => [],
    splitText, sendOnce, log: () => {}, sleep: async () => {},
    db: { prepare: sql => ({run: (...args) => records.push({sql,args})}) },
  });
  vm.runInContext(clean + '\n' + outcomeCode + '\n' + send, scope);
  return {scope,records};
}
const row = {reply_text:'正文',message_id:'test',client_id:'test'};
test('cancel during first segment preserves accepted receipt and skips next segment', async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const calls = [];
  const {scope,records} = harness(async (_account,_user,text) => {
    calls.push(text); await gate; return 'sent';
  }, () => ['第一段','第二段']);
  const pending = scope.sendReply({}, row, controller.signal);
  controller.abort(); release();
  assert.equal(await pending, 'aborted');
  assert.deepEqual(calls, ['第一段']);
  const actual = JSON.parse(records.at(-1).args[0]);
  assert.deepEqual(actual, [{client_id:'test:seg1',status:'sent'}]);
  assert.equal(records.at(-1).args[1], 'partial');
});
test('file-only text skips sending; original paths are removed and URLs survive', async () => {
  const {scope} = harness(() => {throw new Error('unexpected send');});
  assert.equal(await scope.sendReply({}, {...row,reply_text:'生成文件：/local/file.png'}, null), 'skipped');
  assert.equal(scope.cleanReplyForWechat('回「hello」：已生成。\n生成文件：/local/file.png\n任务test回复完毕。', 'test'), '已生成。');
  const link = 'https://example.com/home/help https://example.com/tmp/image';
  assert.equal(scope.cleanReplyForWechat(link, 'test'), link);
});
test('attachment rejection corrects delivery claim before user text is sent', async () => {
  let text;
  const {scope} = harness(async (_account,_user,value) => {text=value; return 'sent';});
  assert.equal(await scope.sendReply({}, {...row,reply_text:'回「附件」：已发给你。'}, null, [{status:'failed'}]), 'sent');
  assert.equal(text, '已生成。');
});
test('text rejection remains failed and is recorded for its segment', async () => {
  const {scope,records} = harness(async () => 'failed');
  assert.equal(await scope.sendReply({}, row, null), 'failed');
  const segmentRecord = records.find(r => r.sql.includes('text_send_results') && JSON.parse(r.args[0])[0]?.status === 'failed');
  assert.ok(segmentRecord);
});
test('final status combines all attachments with text and does not call an empty response delivered', () => {
  const {scope} = harness(async () => 'sent');
  for (const [text,files,expected] of [
    ['sent', [{status:'failed'}], 'failed'],
    ['sent', [{status:'unknown'}], 'unknown'],
    ['skipped', [{status:'ok'},{status:'ok'}], 'sent'],
    ['skipped', [], 'unknown'],
    ['failed', [{status:'ok'}], 'failed'],
    ['aborted', [{status:'ok'}], null],
  ]) assert.equal(scope.deliveryOutcome(text, files), expected);
});
test('restart preserves uncertain running/replied tasks without replaying any send', async () => {
  const transitions = [], output = [];
  const scope = vm.createContext({
    stopping: false,
    db: {prepare: sql => ({
      all: () => [{message_id:'running-id',status:'running'},{message_id:'replied-id',status:'replied'}],
      run: (...args) => output.push(args),
    })},
    getHistoryRaw: async () => [], findMarkedReply: () => ({text:'已生成。'}), stripMarker: text => text,
    log: () => {}, redact: text => text,
    setStatusIfNotFinal: (id,status) => transitions.push([id,status]),
    sendReply: () => {throw new Error('unexpected replay');},
  });
  vm.runInContext(source.slice(source.indexOf('async function recoverOnStartup'), source.indexOf('let stopping = false')), scope);
  await scope.recoverOnStartup({});
  assert.deepEqual(transitions, [['running-id','unknown'],['replied-id','unknown']]);
  assert.equal(output[0][0], '已生成。');
});
