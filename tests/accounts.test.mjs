import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = fs.readFileSync(new URL('../bridge/bridge.js',import.meta.url),'utf8');
const accountCode = source.slice(source.indexOf('function verifyBoundWechatAccount'),source.indexOf('function buildMuseText'));
function harness({ids=[],user='family',storedUser='family',env={},oldUser='owner'}={}) {
  const writes=[];
  const scope = vm.createContext({
    config:{ilink_user_id:user},process:{env},path,OLD_BRIDGE_STATE:'/fake-old',log:() => {},
    fs:{existsSync:() => true,readFileSync:() => JSON.stringify({ilink_bot_id:'owner',ilink_user_id:oldUser,bot_token:'fake'})},
    sdkAccounts:{
      listWeixinAccountIds:() => ids,normalizeAccountId:String,
      resolveWeixinAccount:id => ({accountId:id,configured:true}),
      loadWeixinAccount:() => ({userId:storedUser}),
      saveWeixinAccount:(...args) => writes.push(args),registerWeixinAccountId:() => writes.push('register'),
    },
    DatabaseSync:class {constructor() {throw new Error('unexpected old DB read');}},
  });
  vm.runInContext(accountCode,scope);
  return {scope,writes};
}
test('fresh/family profile does not implicitly import owner state', () => {
  const {scope,writes}=harness();
  assert.throws(() => scope.ensureWechatAccount(),/未找到微信登录账号/);
  assert.deepEqual(writes,[]);
});
test('stored scanner must match configured user', () => {
  assert.throws(() => harness({ids:['owner'],storedUser:'owner'}).scope.ensureWechatAccount(),/不匹配/);
  const {scope,writes}=harness({ids:['family']});
  assert.equal(scope.ensureWechatAccount().accountId,'family');assert.deepEqual(writes,[]);
});
test('explicit wrong account is rejected even when there is only one account', () => {
  const {scope}=harness({ids:['family'],env:{WECHAT_MUSE_ACCOUNT_ID:'missing'}});
  assert.throws(() => scope.ensureWechatAccount(),/不在已登录列表/);
});
test('opt-in migration refuses another scanner before writing credentials', () => {
  const {scope,writes}=harness({env:{WECHAT_MUSE_ALLOW_OLD_IMPORT:'1'}});
  assert.throws(() => scope.ensureWechatAccount(),/拒绝迁移/);assert.deepEqual(writes,[]);
});
test('old dedup data is not read for a different selected account or scanner', () => {
  for (const options of [
    {ids:['owner','family']},
    {ids:['owner'],storedUser:'owner',oldUser:'owner'},
  ]) {
    const {scope}=harness({...options,env:{WECHAT_MUSE_ALLOW_OLD_IMPORT:'1'}});
    assert.deepEqual(Array.from(scope.seedDedup({accountId:'family'})),[]);
  }
});
