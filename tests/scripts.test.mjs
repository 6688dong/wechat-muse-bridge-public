import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = fileURLToPath(new URL('../',import.meta.url));
const bash = process.env.BRIDGE_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
function fixture() {
  const dir = fs.mkdtempSync(path.join(root,'.test-tmp-scripts-'));
  const home = path.join(dir,'home');
  const bridge = path.join(home,'wechat-muse-bridge','bridge');
  const backups = path.join(home,'wechat-muse-bridge','backups','default');
  const bin = path.join(dir,'bin');
  for(const target of [bridge,backups,bin]) fs.mkdirSync(target,{recursive:true});
  fs.writeFileSync(path.join(bridge,'bridge.js'),'export const version = "current";\n');
  const calls = path.join(dir,'calls');
  fs.writeFileSync(path.join(bin,'sudo'),'#!/usr/bin/env bash\nexec "$@"\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'systemctl'),'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\n',{mode:0o755});
  const norm = text => text.replaceAll('\\','/').replace(/^([A-Za-z]):\//,(_, drive) => `/${drive.toLowerCase()}/`);
  const env = {...process.env,HOME:norm(home),USERPROFILE:home,TEST_CALLS:norm(calls),NODE_BIN:norm(process.execPath)};
  function run(script,args) {
    // Set child PATH inside bash to avoid Windows PATH delimiter conversion.
    const scriptPath = path.isAbsolute(script) ? script : path.join(root,'scripts',script);
    return spawnSync(bash,['-c','export PATH="$1:$PATH"; shift; exec bash "$@"','test',norm(bin),norm(scriptPath),...args.map(norm)],{env,encoding:'utf8'});
  }
  function close() {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(root));
    fs.rmSync(dir,{recursive:true,force:true});
  }
  return {dir,home,bridge,backups,bin,calls,run,close};
}
test('invalid profile names fail before installation or service mutation', () => {
  const f=fixture();
  try {
    for(const [script,args] of [['deploy.sh',['../escape']],['add-account.sh',['default']],['verify.sh',['../escape','marker']],['rollback.sh',['../escape']]]) {
      const result=f.run(script,args);
      assert.notEqual(result.status,0,script+' should refuse invalid profile');
    }
    assert.equal(fs.existsSync(f.calls),false);
  } finally {f.close();}
});
test('rollback rejects sibling-prefix and parent-traversal backups without changing code', () => {
  const f=fixture();
  try {
    const sibling=path.join(path.dirname(f.backups),'default-other'); fs.mkdirSync(sibling);
    const other=path.join(sibling,'bridge.js.backup-1'); fs.writeFileSync(other,'export const version="other";');
    for(const backup of [other,path.join(f.backups,'..','default-other','bridge.js.backup-1')]) {
      assert.notEqual(f.run('rollback.sh',['default',backup.replaceAll('\\','/')]).status,0);
    }
    assert.match(fs.readFileSync(path.join(f.bridge,'bridge.js'),'utf8'),/current/);
    assert.equal(fs.existsSync(f.calls),false);
  } finally {f.close();}
});
test('syntax-invalid rollback is rejected before stopping service or overwriting runtime', () => {
  const f=fixture();
  try {
    const backup=path.join(f.backups,'bridge.js.backup-invalid'); fs.writeFileSync(backup,'export const = broken;');
    const result=f.run('rollback.sh',['default',backup.replaceAll('\\','/')]);
    assert.notEqual(result.status,0,result.stdout);
    assert.match(fs.readFileSync(path.join(f.bridge,'bridge.js'),'utf8'),/current/);
    assert.equal(fs.existsSync(f.calls),false);
  } finally {f.close();}
});
test('valid rollback replaces exactly the validated code and restarts only this profile', () => {
  const f=fixture();
  try {
    const code='export const version = "backup";\n';
    const backup=path.join(f.backups,'bridge.js.backup-good'); fs.writeFileSync(backup,code);
    const result=f.run('rollback.sh',['default',backup.replaceAll('\\','/')]);
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    assert.equal(fs.readFileSync(path.join(f.bridge,'bridge.js'),'utf8'),code);
    assert.deepEqual(fs.readFileSync(f.calls,'utf8').trim().split('\n'),[
      'stop wechat-muse-bridge.service','start wechat-muse-bridge.service','is-active wechat-muse-bridge.service']);
  } finally {f.close();}
});

test('family installation owns its dependencies and preserves default and existing profile state', () => {
  const f=fixture();
  try {
    const repo=path.join(f.dir,'repo');
    const source=path.join(repo,'bridge');
    fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});
    for(const script of ['deploy.sh','add-account.sh']) fs.copyFileSync(path.join(root,'scripts',script),path.join(repo,'scripts',script));
    for(const child of ['vendor','dist']) fs.mkdirSync(path.join(source,child),{recursive:true});
    fs.writeFileSync(path.join(source,'bridge.js'),'export const version="candidate";\n');
    for(const file of ['package.json','package-lock.json','tsconfig.vendor.json','config.example.json']) fs.writeFileSync(path.join(source,file),'{}\n');
    fs.writeFileSync(path.join(source,'vendor','fixture'),'vendor fixture');
    fs.writeFileSync(path.join(source,'dist','fixture.js'),'export const compiled=true;\n');
    fs.writeFileSync(path.join(f.bin,'npm'),'#!/usr/bin/env bash\nmkdir -p node_modules\nprintf "%s\\n" "$PWD:$*" >> "$TEST_CALLS"\n',{mode:0o755});
    fs.mkdirSync(path.join(f.bridge,'state'));
    fs.writeFileSync(path.join(f.bridge,'state','owner'),'owner state');
    fs.writeFileSync(path.join(f.bridge,'config.json'),'owner config');
    const add=path.join(repo,'scripts','add-account.sh');
    const result=f.run(add,['family']);
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    const family=path.join(f.bridge,'profiles','family');
    assert.equal(fs.lstatSync(path.join(family,'node_modules')).isSymbolicLink(),false);
    assert.equal(fs.existsSync(path.join(family,'dist','dist')),false);
    fs.writeFileSync(path.join(family,'config.json'),'family config');
    fs.writeFileSync(path.join(family,'state','family'),'family state');
    const redeploy=f.run(path.join(repo,'scripts','deploy.sh'),['family']);
    assert.equal(redeploy.status,0,redeploy.stdout+'\n'+redeploy.stderr);
    assert.notEqual(f.run(add,['family']).status,0);
    assert.equal(fs.readFileSync(path.join(family,'config.json'),'utf8'),'family config');
    assert.equal(fs.readFileSync(path.join(family,'state','family'),'utf8'),'family state');
    assert.equal(fs.readFileSync(path.join(f.bridge,'config.json'),'utf8'),'owner config');
    assert.equal(fs.readFileSync(path.join(f.bridge,'state','owner'),'utf8'),'owner state');
  } finally {f.close();}
});
