import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = fileURLToPath(new URL('../',import.meta.url));
const script = fileURLToPath(new URL('../scripts/qr-login.mjs',import.meta.url));
const loader = new URL('./qr-loader.mjs',import.meta.url).href;
const register = 'data:text/javascript,' + encodeURIComponent(`import {register} from 'node:module'; register(${JSON.stringify(loader)});`);
function fixture(profile,expected='YOUR_WECHAT_USER_ID') {
  const home = fs.mkdtempSync(path.join(root,'.test-tmp-qr-'));
  const base = path.join(home,'wechat-muse-bridge','bridge');
  const target = profile === 'default' ? base : path.join(base,'profiles',profile);
  fs.mkdirSync(target,{recursive:true});
  fs.writeFileSync(path.join(target,'config.json'),JSON.stringify({ilink_user_id:expected}));
  const owner = path.join(base,'state','owner-preserved.txt');
  fs.mkdirSync(path.dirname(owner),{recursive:true}); fs.writeFileSync(owner,'owner state fixture');
  const state = path.join(target,'state','weixin','openclaw-weixin');
  const run = result => spawnSync(process.execPath,['--import',register,script,'--profile',profile],{
    encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,QR_TEST_RESULT:JSON.stringify(result)},timeout:10000,
  });
  const cleanup = () => {
    assert.equal(path.dirname(path.resolve(home)),path.resolve(root));
    assert.ok(path.basename(home).startsWith('.test-tmp-qr-'));
    fs.rmSync(home,{recursive:true,force:true});
  };
  return {home,state,owner,run,cleanup};
}
const success = {connected:true,botToken:'fake-token',accountId:'fake@im.bot',baseUrl:'https://example.invalid',userId:'family@im.wechat',message:'confirmed'};
for (const profile of ['default','family']) test(`successful SDK result persists in ${profile} bridge state`, () => {
  const f = fixture(profile);
  try {
    const result = f.run(success);
    assert.equal(result.status,0,result.stderr);
    const account = JSON.parse(fs.readFileSync(path.join(f.state,'accounts','fake-im-bot.json'),'utf8'));
    assert.equal(account.userId,success.userId); assert.equal(account.token,success.botToken);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.state,'accounts.json'),'utf8')),['fake-im-bot']);
    assert.equal(fs.readFileSync(f.owner,'utf8'),'owner state fixture');
  } finally {f.cleanup();}
});
test('SDK failure and wrong configured scanner save no credential', () => {
  for (const [expected,result] of [['family@im.wechat',{connected:false,message:'cancelled'}],['owner@im.wechat',success]]) {
    const f = fixture('family',expected);
    try {assert.equal(f.run(result).status,1);assert.equal(fs.existsSync(path.join(f.state,'accounts.json')),false);}
    finally {f.cleanup();}
  }
});
test('an existing login is preserved without entering QR flow', () => {
  const f = fixture('family');
  try {
    fs.mkdirSync(f.state,{recursive:true});
    const index = path.join(f.state,'accounts.json'); fs.writeFileSync(index,'["existing"]');
    assert.equal(f.run({connected:false}).status,0);
    assert.equal(fs.readFileSync(index,'utf8'),'["existing"]');
    assert.equal(fs.readFileSync(f.owner,'utf8'),'owner state fixture');
  } finally {f.cleanup();}
});
