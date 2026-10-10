const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./load-core.js');

const SAMPLE = path.join(__dirname, '..', '..', fs.readdirSync(path.join(__dirname, '..', '..')).find((f) => f.normalize('NFC') === '진도카드_20261009.csv'));
const sample = () => C.readCsv('진도카드_20261009.csv', fs.readFileSync(SAMPLE, 'utf8'));
const ROSTER = [
  { no: '56', name: '김도윤', status: '재원' },
  { no: '43', name: '이지아', status: '재원' },
  { no: '73', name: '박채아', status: '재원' },
];
const issuesOf = (card, ctx = {}) => C.validateCard(card.values, { cellCount: card.cellCount, roster: ROSTER, fileDate: '2026-10-09', ...ctx });

test('샘플 CSV: 제목 줄 통과, 카드 3장, 학생번호 문자열 유지', () => {
  const r = sample();
  assert.deepEqual(r.headerErrors, []);
  assert.equal(r.fileDate, '2026-10-09');
  assert.equal(r.cards.length, 3);
  assert.deepEqual(r.cards.map((c) => c.values.학생번호), ['56', '43', '73']);
  assert.deepEqual(r.cards.map((c) => c.rowNo), [2, 3, 4]);
});

test('샘플 CSV: 도윤 카드가 맨 위(확인필요), 나머지 문제없음', () => {
  const r = sample();
  const ranked = r.cards.map((c) => ({ c, rank: C.rankOf(c.values, issuesOf(c)) }));
  ranked.sort((a, b) => a.rank - b.rank);
  assert.equal(ranked[0].c.values.이름, '도윤');
  assert.equal(ranked[0].rank, 0);
  const doyun = issuesOf(r.cards[0]);
  assert.deepEqual(doyun.map((x) => x.field), ['지난과제범위']);
  assert.deepEqual(issuesOf(r.cards[1]), []);
  assert.deepEqual(issuesOf(r.cards[2]), []);
  assert.equal(C.splitList(r.cards[0].values.확인필요).length, 3);
});

test('범위 항목 해석', () => {
  assert.deepEqual(C.parseRangeItem('디딤돌[95~97]○'), { raw: '디딤돌[95~97]○', ok: true, book: '디딤돌', unit: '', range: '95~97', mark: '○' });
  assert.deepEqual(C.parseRangeItem('교재오답(3)[~Step3]○'), { raw: '교재오답(3)[~Step3]○', ok: true, book: '교재오답', unit: '3', range: '~Step3', mark: '○' });
  assert.equal(C.parseRangeItem('교재오답-자료집(3)[]○').book, '교재오답-자료집');
  assert.equal(C.parseRangeItem('경시[기출 연습]△').mark, '△');
  assert.equal(C.parseRangeItem('디딤돌[98~102]').mark, '');
  assert.equal(C.parseRangeItem('주간Test(3)[①]').range, '①');
  assert.equal(C.parseRangeItem('디딤돌[112~]○').range, '112~');
  assert.equal(C.parseRangeItem('디딤돌 95~97').ok, false);
  assert.equal(C.parseRangeItem('수학익힘[3]').ok, false);
  assert.equal(C.parseRangeItem('디딤돌[95]x').ok, false);
});

test('열 이름·순서 오류는 몇 번째 열인지 알려 준다', () => {
  const swapped = [...C.HEADERS];
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  const r = C.readCsv('a.csv', swapped.join(',') + '\n');
  assert.equal(r.headerErrors[0], '열 이름은 모두 있지만 순서가 다릅니다.');
  assert.match(r.headerErrors[1], /^5번째 열 이름이 "하원"입니다/);
  const short = C.readCsv('a.csv', C.HEADERS.slice(0, 17).join(','));
  assert.deepEqual(short.headerErrors, ['18번째 열 이름이 (없음)입니다. 올바른 이름: "확인필요"']);
});

const base = () => ({
  수업일: '2026-10-09', 학생번호: '56', 이름: '도윤', 출결: '정규', 등원: '16:00', 하원: '17:30', '수업시간(분)': '90',
  지난과제: '완료', 단계: '개념; 유형', 진행률: '50~75%', 오답원인: '', 추가포인트: '3',
  지난과제범위: '디딤돌[1~2]○', 오늘진도범위: '', 추가포인트범위: '', 오늘과제: '', 학습태도: '', 확인필요: '',
});
const v = (patch, ctx) => C.validateCard({ ...base(), ...patch }, { roster: ROSTER, ...ctx });

test('목록에 없는 값·형식 오류는 오류', () => {
  assert.deepEqual(v({}), []);
  assert.equal(v({ 출결: '출석' })[0].level, 'error');
  assert.equal(v({ 단계: '개념; 응용' })[0].msg.startsWith('목록에 없는 값: "응용"'), true);
  assert.equal(v({ 등원: '4:00' })[0].field, '등원');
  assert.equal(v({ 수업일: '2026-02-30' })[0].field, '수업일');
  assert.match(v({ 학생번호: '5' })[0].msg, /"05"/);
  assert.equal(v({ 추가포인트: '5' })[0].field, '추가포인트');
  assert.equal(v({ 하원: '15:00' })[0].field, '하원');
});

test('결강은 시간·단계 등이 비어도 된다', () => {
  assert.deepEqual(v({ 출결: '결강', 등원: '', 하원: '', '수업시간(분)': '', 지난과제: '', 단계: '', 진행률: '', 추가포인트: '' }), []);
  assert.equal(v({ 출결: '정규', 단계: '' })[0].msg, '비어 있습니다.');
});

test('페이지 추가 검사(경고)', () => {
  assert.match(v({ '수업시간(분)': '80' })[0].msg, /차이는 90분인데 수업시간은 80분/);
  assert.equal(v({ 지난과제: '과제 없음' })[0].field, '지난과제범위');
  assert.match(v({ 학생번호: '99' })[0].msg, /명단에 99번 학생이 없습니다. 이름이 같은 학생: 56번 김도윤/);
  assert.match(v({ 이름: '지아' })[0].msg, /명단의 56번은 "김도윤"/);
  assert.equal(v({}, { existing: { 출결: '정규' } })[0].field, '_dup');
  assert.equal(v({}, { batchCount: 2 })[0].level, 'error');
  assert.equal(v({ 오늘과제: '디딤돌 [3]' })[0].field, '오늘과제');
});

test('칸 개수가 18개가 아니면 확인 전까지 오류', () => {
  const r = C.readCsv('x.csv', C.HEADERS.join(',') + '\n2026-10-09,56,도윤');
  const c = r.cards[0];
  assert.equal(c.cellCount, 3);
  assert.ok(C.validateCard(c.values, { cellCount: 3 }).some((x) => x.field === '_cells'));
  assert.ok(!C.validateCard(c.values, { cellCount: 3, cellsOk: true }).some((x) => x.field === '_cells'));
});

test('따옴표·줄바꿈이 든 칸, BOM, CRLF', () => {
  const text = '﻿' + C.HEADERS.join(',') + '\r\n'
    + '2026-10-09,56,도윤,정규,16:00,17:30,90,완료,개념,50~75%,,0,,,,,"첫 줄\n둘째 줄, ""인용""",\r\n\r\n'
    + '2026-10-09,43,지아,결강,,,,,,,,,,,,,,\r\n';
  const r = C.readCsv('진도카드_20261009.csv', text);
  assert.deepEqual(r.headerErrors, []);
  assert.equal(r.cards[0].values.학습태도, '첫 줄\n둘째 줄, "인용"');
  assert.deepEqual(r.cards.map((c) => c.rowNo), [2, 4]);
});

test('이름 비교: 성을 뺀 이름도 같은 사람', () => {
  assert.ok(C.nameMatches('도윤', '김도윤'));
  assert.ok(C.nameMatches('김도윤', '김도윤'));
  assert.ok(C.nameMatches('하늘', '남궁하늘'));
  assert.ok(!C.nameMatches('지아', '김도윤'));
  assert.ok(!C.nameMatches('윤', '김도윤'));
});

test('저장용 정리: 여러 개 칸 구분자 통일', () => {
  assert.equal(C.canonical({ ...base(), 단계: '개념;유형 ;' }).단계, '개념; 유형');
});

test('명단 붙여넣기 해석과 비교', () => {
  const { list, invalid } = C.parseRosterText('56\t김도윤\t초4\n7, 박하늘, 초3\n\nxx 이름\n56 중복');
  assert.deepEqual(list, [{ no: '56', name: '김도윤', grade: '초4' }, { no: '07', name: '박하늘', grade: '초3' }]);
  assert.equal(invalid.length, 2);
  const current = [
    { no: '56', name: '김도윤', grade: '초3', status: '재원' },
    { no: '43', name: '이지아', grade: '초5', status: '재원' },
    { no: '10', name: '최퇴원', grade: '', status: '퇴원' },
  ];
  const d = C.diffRoster(current, list);
  assert.deepEqual(d.add, [{ no: '07', name: '박하늘', grade: '초3' }]);
  assert.deepEqual(d.update.map((u) => [u.no, u.to.grade]), [['56', '초4']]);
  assert.deepEqual(d.missing, [{ no: '43', name: '이지아' }]);
});
