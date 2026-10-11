import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const root = fileURLToPath(new URL('../', import.meta.url));
test('verification matches a literal quote/percent marker and does not change the DB', () => {
  const dir = fs.mkdtempSync(path.join(root,'.test-tmp-verify-'));
  const file = path.join(dir,'tasks.db');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE tasks(message_id TEXT, text TEXT, status TEXT, send_receipt TEXT, created_at INTEGER)');
    const insert = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)');
    insert.run('expected',"quote'%_",'sent','sent',2);
    insert.run('other','quote-wildcard','sent','sent',1);
    db.close();
    const before = fs.readFileSync(file);
    const result = spawnSync(process.execPath,[path.join(root,'scripts/verify-record.mjs'),file,"quote'%_"],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).map(row => row.message_id),['expected']);
    assert.deepEqual(fs.readFileSync(file),before);
    const missing = path.join(dir,'missing.db');
    const failure = spawnSync(process.execPath,[path.join(root,'scripts/verify-record.mjs'),missing,'anything'],{encoding:'utf8'});
    assert.notEqual(failure.status,0); assert.equal(fs.existsSync(missing),false);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(root));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
