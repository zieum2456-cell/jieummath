const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('./fake-gas.js');
const C = require('./load-core.js');

const DIR = path.join(__dirname, '..', '..');
const SAMPLE_BYTES = fs.readFileSync(path.join(DIR, fs.readdirSync(DIR).find((f) => f.normalize('NFC') === '진도카드_20261009.csv')));
const plain = (x) => JSON.parse(JSON.stringify(x));

function fresh(opts) {
  const g = loadGas(opts);
  g.ctx.setup();
  return g;
}

function register(g, bytes = SAMPLE_BYTES, name = '진도카드_20261009.csv') {
  return plain(g.ctx.api_registerUpload({ fileName: name, b64: bytes.toString('base64'), classDate: '2026-10-09', cardCount: 3, reviewCount: 1 }));
}

/** 확인 화면이 하는 일을 흉내: 대기 목록 → 카드 → 저장 요청 */
function pendingCards(g) {
  return plain(g.ctx.api_pending()).flatMap((u) => C.readCsv(u.fileName, u.text).cards
    .filter((c) => u.handledRows.indexOf(c.rowNo) < 0)
    .map((c) => ({ uploadId: u.uploadId, rowNo: c.rowNo, key: C.cardKey(c.values), label: `${c.values.학생번호} ${c.values.이름}`, fileName: u.fileName, values: C.canonical(c.values), edited: [], warnings: [] })));
}

test('setup: 탭 4개와 기본 설정, 원본 폴더를 만든다', () => {
  const g = fresh();
  assert.deepEqual(g.ss.getSheets().map((s) => s.getName()), ['학생명단', '수업기록', '업로드이력', '설정']);
  const st = plain(g.ctx.api_init()).settings;
  assert.equal(st.두고옴처리, '안 함과 같이(×0)');
  assert.ok(st.원본폴더ID);
  assert.equal(g.root.folders[0].getName(), '진도카드 원본');
  g.ctx.setup(); // 두 번 실행해도 그대로
  assert.equal(g.ss.getSheetByName('설정').objects().length, 3);
});

test('업로드: 월별 폴더에 원본을 그대로 보관하고 확인 대기로 올린다', () => {
  const g = fresh();
  const r = register(g);
  assert.equal(r.duplicate, '');
  const month = g.root.folders[0].folders[0];
  assert.equal(month.getName(), '2026-10');
  assert.ok(month.files[0].getBlob().buf.equals(SAMPLE_BYTES)); // BOM 포함 원본 그대로
  const p = plain(g.ctx.api_pending());
  assert.equal(p.length, 1);
  assert.equal(p[0].status, '확인 대기');
  assert.equal(C.readCsv(p[0].fileName, p[0].text).cards.length, 3);
  // 같은 파일을 또 올리면 새로 만들지 않음
  assert.equal(register(g).duplicate, 'pending');
  assert.equal(month.files.length, 1);
});

test('저장: 카드가 수업기록에 들어가고, 확인필요는 해결로 표시, 업로드이력 갱신', () => {
  const g = fresh();
  register(g);
  const cards = pendingCards(g);
  const res = plain(g.ctx.api_save({ cards: cards.slice(0, 2), skips: [] }));
  assert.deepEqual(res.cards.map((x) => x.status), ['saved', 'saved']);
  assert.ok(res.logs[0].ok);
  assert.equal(res.logs[0].status, '일부 저장');
  const rec = g.ss.getSheetByName('수업기록').objects();
  assert.equal(rec.length, 2);
  assert.equal(rec[0].기록ID, '2026-10-09_56');
  assert.equal(rec[0].학생번호, '56');
  assert.equal(rec[0].확인필요상태, '해결');
  assert.ok(rec[0].해결일시);
  assert.equal(rec[1].확인필요상태, '없음');
  assert.equal(rec[0]['수업시간(분)'], '55');
  // 남은 카드만 다시 대기 목록에 나온다
  const left = pendingCards(g);
  assert.deepEqual(left.map((c) => c.rowNo), [4]);
  const res2 = plain(g.ctx.api_save({ cards: [], skips: [{ uploadId: left[0].uploadId, rowNo: 4, label: '73 채아', reason: '저장 안 함' }] }));
  assert.equal(res2.logs[0].status, '저장 완료');
  assert.equal(plain(g.ctx.api_pending()).length, 0);
  const log = g.ss.getSheetByName('업로드이력').objects()[0];
  assert.equal(log.저장, '2');
  assert.equal(log.건너뜀, '1');
  assert.equal(log.남은카드, '0');
  assert.match(log.처리내역, /^2행\(56 도윤\) 저장; 3행\(43 지아\) 저장; 4행\(73 채아\) 건너뜀·저장 안 함$/);
});

test('중복: 덮어쓰기를 고르지 않으면 실패, 고르면 같은 행을 고친다', () => {
  const g = fresh();
  register(g);
  const cards = pendingCards(g);
  g.ctx.api_save({ cards: [cards[0]], skips: [] });
  const lk = plain(g.ctx.api_lookup(['2026-10-09_56', '2026-10-09_43']));
  assert.deepEqual(Object.keys(lk), ['2026-10-09_56']);
  // 같은 내용 파일을 다시 올린 경우 (이미 일부 저장된 업로드라 pending 중복)
  const again = { ...cards[0], uploadId: 'other' };
  assert.equal(plain(g.ctx.api_save({ cards: [again], skips: [] })).cards[0].status, 'failed');
  const changed = { ...cards[0], overwrite: true, values: { ...cards[0].values, 학습태도: '고침' }, edited: ['학습태도'] };
  assert.equal(plain(g.ctx.api_save({ cards: [changed], skips: [] })).cards[0].status, 'overwritten');
  const rec = g.ss.getSheetByName('수업기록').objects();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].학습태도, '고침');
  assert.equal(rec[0].수정한칸, '학습태도');
  assert.ok(rec[0].수정일시);
});

test('쓰기 오류: 어느 카드가 저장되지 않았는지 알려 준다', () => {
  const g = fresh();
  register(g);
  const cards = pendingCards(g);
  const sh = g.ss.getSheetByName('수업기록');
  // 한꺼번에 쓰기 실패 → 한 장씩 재시도. 첫 재시도도 실패하게 두 번 실패시킨다
  let fails = 2;
  const orig = sh.set.bind(sh);
  sh.set = (r, c, v) => {
    if (fails > 0 && c === 1) {
      fails--;
      throw new Error('가짜 쓰기 오류');
    }
    return orig(r, c, v);
  };
  const res = plain(g.ctx.api_save({ cards, skips: [] }));
  assert.deepEqual(res.cards.map((x) => x.status), ['failed', 'saved', 'saved']);
  assert.equal(res.cards[0].error, '가짜 쓰기 오류');
  assert.equal(res.logs[0].status, '일부 저장');
  assert.deepEqual(pendingCards(g).map((c) => c.rowNo), [2]);
});

test('드라이브 오류면 업로드 등록 자체가 실패한다', () => {
  const g = fresh();
  g.drive.failNext = true;
  assert.throws(() => register(g), /가짜 드라이브 오류/);
  assert.equal(plain(g.ctx.api_pending()).length, 0);
});

test('명단: 결제일 관리에서 불러오기 → 반영, 디딤돌 레벨은 유지', () => {
  const g = fresh({ payment: { students: [{ no: '56', name: '김도윤', grade: '초4' }, { no: '', name: '번호없음' }, { no: '43', name: '이지아', grade: '초5' }] } });
  const r = plain(g.ctx.api_fetchPaymentRoster());
  assert.deepEqual(r.students.map((s) => s.no), ['56', '43']);
  assert.deepEqual(r.noNumber, ['번호없음']);
  assert.equal(g.fetchLog[0].o.headers['X-Goog-User-Project'], 'jieummath');
  g.ctx.api_applyRoster({ add: r.students, update: [], retire: [] });
  const sh = g.ss.getSheetByName('학생명단');
  sh.getRange(2, 4).setValue('기본+응용');
  const roster = plain(g.ctx.api_applyRoster({ add: [], update: [{ no: '56', name: '김도윤', grade: '초5' }], retire: ['43'] }));
  assert.deepEqual(roster.map((s) => [s.no, s.grade, s.level, s.status]), [['56', '초5', '기본+응용', '재원'], ['43', '초5', '', '퇴원']]);
  assert.throws(() => g.ctx.api_addStudent({ no: '56', name: '도윤' }), /이미 명단에/);
});

test('명단: Firebase 읽기 실패 시 이유를 알려 준다', () => {
  const g = fresh({ firestoreStatus: 403 });
  assert.throws(() => g.ctx.api_fetchPaymentRoster(), /403 \/ 403.*Permission denied/);
  assert.equal(g.fetchLog.length, 2); // 헤더 있이 한 번, 없이 한 번
});

test('번호 변경: 명단과 수업기록(학생번호·기록ID)을 함께 바꾼다', () => {
  const g = fresh();
  g.ctx.api_applyRoster({ add: [{ no: '56', name: '김도윤', grade: '초4' }, { no: '43', name: '이지아', grade: '초5' }], update: [], retire: [] });
  register(g);
  g.ctx.api_save({ cards: pendingCards(g), skips: [] });
  const plan = plain(g.ctx.api_changeNo({ from: '56', to: '57', dryRun: true }));
  assert.equal(plan.count, 1);
  assert.equal(g.ss.getSheetByName('수업기록').objects()[0].학생번호, '56'); // 미리 보기는 바꾸지 않음
  const r = plain(g.ctx.api_changeNo({ from: '56', to: '57' }));
  assert.deepEqual(r.roster.map((s) => s.no), ['57', '43']);
  assert.match(r.roster[0].memo, /56번에서 57번으로 변경\(기록 1건\)/);
  const rec = g.ss.getSheetByName('수업기록').objects();
  assert.deepEqual(rec.map((x) => [x.기록ID, x.학생번호]), [['2026-10-09_57', '57'], ['2026-10-09_43', '43'], ['2026-10-09_73', '73']]);
  assert.ok(rec[0].수정일시);
  assert.equal(rec[1].수정일시, '');
  assert.equal(rec[0].학습태도, '서술형 풀이 첫 단어/문장 제시하면 스스로 작성 가능'); // 다른 칸은 그대로
});

test('번호 변경: 이미 쓰는 번호, 겹치는 날짜, 형식 오류는 막는다', () => {
  const g = fresh();
  g.ctx.api_applyRoster({ add: [{ no: '56', name: '김도윤' }, { no: '43', name: '이지아' }], update: [], retire: [] });
  g.ctx.api_applyRoster({ add: [], update: [], retire: ['43'] });
  assert.throws(() => g.ctx.api_changeNo({ from: '56', to: '43' }), /이지아\(퇴원\) 학생이 쓰고 있습니다/);
  assert.throws(() => g.ctx.api_changeNo({ from: '56', to: '5' }), /두 자리/);
  assert.throws(() => g.ctx.api_changeNo({ from: '99', to: '98' }), /명단에 99번/);
  // 새 번호로 같은 날짜 기록이 이미 있으면 막음 (명단에는 없는 번호 73의 기록)
  register(g);
  g.ctx.api_save({ cards: pendingCards(g), skips: [] });
  assert.throws(() => g.ctx.api_changeNo({ from: '56', to: '73' }), /날짜가 겹칩니다: 2026-10-09/);
  assert.equal(g.ss.getSheetByName('수업기록').objects()[0].학생번호, '56');
});

test('2단계: 기록 읽기, 명단 추가·수정, 내보내기', () => {
  const g = fresh();
  register(g);
  g.ctx.api_save({ cards: pendingCards(g), skips: [] });
  const recs = plain(g.ctx.api_records());
  assert.equal(recs.length, 3);
  assert.equal(recs[0].학생번호, '56');
  assert.equal(recs[0].확인필요상태, '해결');

  plain(g.ctx.api_saveStudent({ isNew: true, no: '56', name: '김도윤', grade: '초4', level: '기본+유형', group: 'A' }));
  assert.throws(() => g.ctx.api_saveStudent({ isNew: true, no: '56', name: '다른학생' }), /이미 김도윤/);
  assert.throws(() => g.ctx.api_saveStudent({ no: '56', name: '김도윤', level: '심화' }), /디딤돌 레벨/);
  const roster = plain(g.ctx.api_saveStudent({ no: '56', name: '김도윤', grade: '초5', level: '기본+응용', group: 'B', status: '재원', memo: '메모' }));
  assert.deepEqual(roster.map((s) => [s.no, s.grade, s.level, s.group, s.memo]), [['56', '초5', '기본+응용', 'B', '메모']]);

  const csv = plain(g.ctx.api_export('csv'));
  assert.match(csv.name, /^진도카드_수업기록_\d{8}-\d{4}\.csv$/);
  const folder = g.root.folders.find((f) => f.getName() === '진도카드 내보내기');
  const text = folder.files[0].getBlob().getDataAsString();
  assert.ok(text.startsWith('﻿기록ID,수업일,학생번호'));
  assert.equal(C.parseCsv(text).length, 4);
  const x = plain(g.ctx.api_export('xlsx'));
  assert.match(x.name, /\.xlsx$/);
  assert.equal(folder.files.length, 2);
});
