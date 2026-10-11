import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// 回归测试：CDN 上传退避重试
// - 500/网络异常最多 5 次，4 次延迟分别为 5/15/30/60 秒
// - 成功不额外等待；4xx 不重试
// - 用假定时器，不真等
const distSource = fs.readFileSync(
  new URL('../bridge/dist/cdn/cdn-upload.js', import.meta.url), 'utf8');

function loadUpload(mockFetch) {
  const delays = [];
  const logs = [];
  // 去掉 ESM import，注入 mock
  const body = distSource
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const scope = vm.createContext({
    fetch: mockFetch,
    setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; },
    clearTimeout: () => {},
    Uint8Array,
    encryptAesEcb: (buf) => Buffer.from(buf),
    buildCdnUploadUrl: ({ cdnBaseUrl, uploadParam, filekey }) =>
      `${cdnBaseUrl}/upload?p=${uploadParam}&k=${filekey}`,
    logger: { debug: () => {}, error: (m) => logs.push(String(m)) },
    redactUrl: (u) => u,
  });
  vm.runInContext(body + '\nthis.uploadBufferToCdn = uploadBufferToCdn;', scope);
  return { upload: scope.uploadBufferToCdn, delays, logs };
}

const baseParams = {
  buf: Buffer.from('x'.repeat(100)),
  uploadParam: 'p1', filekey: 'k1',
  cdnBaseUrl: 'https://cdn.example/c2c',
  label: 't', aeskey: Buffer.alloc(16),
};
const ok500 = (status, encParam = 'enc123') => ({
  status,
  headers: { get: (h) => (h === 'x-encrypted-param' ? encParam : null) },
  text: async () => '',
});

test('500 时最多 5 次，延迟为 5/15/30/60 秒', async () => {
  let calls = 0;
  const { upload, delays } = loadUpload(async () => { calls++; return ok500(500); });
  await assert.rejects(upload({ ...baseParams }), /CDN upload server error/);
  assert.equal(calls, 5);
  assert.deepEqual(delays, [5000, 15000, 30000, 60000]);
});

test('第 3 次成功则不额外等待', async () => {
  let calls = 0;
  const { upload, delays } = loadUpload(async () => {
    calls++;
    return calls < 3 ? ok500(500) : ok500(200);
  });
  const r = await upload({ ...baseParams });
  assert.equal(r.downloadParam, 'enc123');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5000, 15000]);
});

test('4xx 不重试，直接抛错', async () => {
  let calls = 0;
  const { upload, delays } = loadUpload(async () => { calls++; return ok500(404, null); });
  await assert.rejects(upload({ ...baseParams }), /client error 404/);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('网络异常（fetch throw）同样退避 5 次', async () => {
  let calls = 0;
  const { upload, delays } = loadUpload(async () => { calls++; throw new TypeError('fetch failed'); });
  // vm 跨 realm 下 instanceof Error 失效，函数抛聚合错误；关键断言是次数与延迟
  await assert.rejects(upload({ ...baseParams }), /failed after 5 attempts/);
  assert.equal(calls, 5);
  assert.deepEqual(delays, [5000, 15000, 30000, 60000]);
});
