import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source=fs.readFileSync(new URL('../bridge/bridge.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('let stopping = false;'),source.indexOf('// 入口'));

test('actual polling entry loads the account cursor and persists only after the batch',async()=>{
  const calls=[];
  let scope;
  scope=vm.createContext({AbortController, Date, log(){}, redact:String,
    isSessionPaused:()=>false,
    sdkSyncBuf:{
      getSyncBufFilePath:account=>{calls.push(['path',account]);return '/isolated/cursor';},
      loadGetUpdatesBuf:file=>{calls.push(['load',file]);return 'old';},
      saveGetUpdatesBuf:(file,buf)=>{calls.push(['save',file,buf]);vm.runInContext('stopping=true',scope);},
    },
    getUpdates:async args=>{calls.push(['poll',args.get_updates_buf]);return {msgs:[{test:true}],get_updates_buf:'new'};},
    handleMessage:async()=>calls.push(['processed']),
    SESSION_EXPIRED_ERRCODE:-14,
  });
  vm.runInContext(code,scope);
  await scope.mainLoop({accountId:'bot',baseUrl:'test',token:'test'});
  assert.deepEqual(calls,[['path','bot'],['load','/isolated/cursor'],['poll','old'],['processed'],['save','/isolated/cursor','new']]);
});

