const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../cloud.js');

const A = '{"students":[1]}';
const B = '{"students":[1,2]}';

test('온라인에 데이터가 없으면 이 브라우저 데이터를 올린다', () => {
  assert.equal(decide({ local: A, cloud: null }), 'upload');
  assert.equal(decide({ local: null, cloud: null }), 'none');
});

test('이 브라우저에 데이터가 없거나 같으면 온라인 데이터를 쓴다', () => {
  assert.equal(decide({ local: null, cloud: A }), 'download');
  assert.equal(decide({ local: A, cloud: A, linked: false }), 'download');
});

test('이미 연결된 브라우저: 저장 못 한 변경이 있으면 올리고, 없으면 온라인 데이터를 쓴다', () => {
  assert.equal(decide({ local: A, cloud: B, linked: true, dirty: true }), 'upload');
  assert.equal(decide({ local: A, cloud: B, linked: true, dirty: false }), 'download');
});

test('처음 연결하는 브라우저에 다른 데이터가 있으면 물어본다', () => {
  assert.equal(decide({ local: A, cloud: B, linked: false, dirty: false }), 'ask');
});

test('앱 안의 브라우저 감지', () => {
  const C = require('../cloud.js');
  assert.equal(C.inAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 KAKAOTALK 10.4.0'), true);
  assert.equal(C.inAppBrowser('Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.0.0)'), true);
  assert.equal(C.inAppBrowser('Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), false);
  assert.equal(C.inAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), false);
});
