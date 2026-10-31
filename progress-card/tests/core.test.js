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

test('옛 양식 CSV(오답원인 열)는 학습주안점과 새 보기 이름으로 읽는다', () => {
  const r = sample(); // 샘플은 옛 양식
  assert.deepEqual(r.cards.map((c) => c.values.학습주안점), ['계산 실수 교정', '문제 읽기(조건 찾기)', '개념 재학습/오개념 수정; 문제 읽기(조건 찾기)']);
  assert.deepEqual(r.cards.flatMap((c) => issuesOf(c)).filter((x) => x.field === '학습주안점'), []);
  const fresh = C.readCsv('b.csv', C.HEADERS.join(',') + '\n' + C.HEADERS.map((h) => (h === '학습주안점' ? '"풀이 과정 서술; 계산 실수 교정"' : '')).join(','));
  assert.deepEqual(fresh.headerErrors, []);
  assert.equal(fresh.cards[0].values.학습주안점, '풀이 과정 서술; 계산 실수 교정');
});

test('지난과제: 새 보기(50% 이상/미만)와 옛 카드의 미완은 통과, 없는 값은 오류', () => {
  const csv = (x) => C.readCsv('c.csv', C.HEADERS.join(',') + '\n' + C.HEADERS.map((h) => (h === '지난과제' ? x : '')).join(','));
  ['50% 이상', '50% 미만', '미완'].forEach((x) => assert.deepEqual(issuesOf(csv(x).cards[0]).filter((i) => i.field === '지난과제'), []));
  assert.equal(issuesOf(csv('반쯤').cards[0]).filter((i) => i.field === '지난과제').length, 1);
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

test('2026-10-21 교재 8종·경시대회, 페이지 앞 p는 그대로 둔다', () => {
  ['디딤돌', '자료집', '문장제', '탄탄북', '연산', '개념다시쓰기', '교재오답', '학습지오답', '단원Test', '주간Test', '경시대회'].forEach((b) => {
    assert.equal(C.parseRangeItem(`${b}(2)[10~12]○`).book, b);
  });
  assert.equal(C.parseRangeItem('개념다시쓰기(3)[p58~63]').range, 'p58~63');
  assert.equal(C.parseRangeItem('경시[기출 연습]').book, '경시'); // 예전 기록
  const recs = [{ 수업일: '2026-10-20', 출결: '정규', 단계: '개념', 오늘진도범위: '탄탄북(3)[10~12]○; 학습지오답(3)[]○; 경시대회[기출]○' }];
  assert.ok(C.parentReport({ name: '김하린', grade: '초5' }, recs).includes(' · 10/20(화) 개념 학습\n    └ 탄탄북 3단원(합동과 대칭), 학습지 오답 3단원(합동과 대칭), 경시대회\n'));
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
  지난과제: '완료', 단계: '개념; 유형', 진행률: '50~75%', 학습주안점: '', 추가포인트: '3',
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
  assert.equal(C.canonical({ ...base(), 단계: 'Test; 경시' }).단계, '평가; 경시');
});

test('명단 붙여넣기 해석과 비교', () => {
  const { list, invalid } = C.parseRosterText('56\t김도윤\t초4\n7, 박하늘, 초3\n\nxx 이름\n56 중복\n08\t한별\t\t화목\n09 정우 금월 중1');
  assert.deepEqual(list, [
    { no: '56', name: '김도윤', grade: '초4' },
    { no: '07', name: '박하늘', grade: '초3' },
    { no: '08', name: '한별', grade: '', days: '화목' },
    { no: '09', name: '정우', grade: '중1', days: '월금' },
  ]);
  assert.equal(invalid.length, 2);
  const current = [
    { no: '56', name: '김도윤', grade: '초3', days: '월수', status: '재원' },
    { no: '43', name: '이지아', grade: '초5', status: '재원' },
    { no: '10', name: '최퇴원', grade: '', status: '퇴원' },
    { no: '08', name: '한별', grade: '초6', days: '화', status: '재원' },
  ];
  const d = C.diffRoster(current, list);
  assert.deepEqual(d.add, [{ no: '07', name: '박하늘', grade: '초3', days: '', times: '' }, { no: '09', name: '정우', grade: '중1', days: '월금', times: '' }]);
  // 요일 없는 줄은 지금 요일 유지, 요일만 바뀌어도 변경으로 잡는다
  assert.deepEqual(d.update.map((u) => [u.no, u.to.grade, u.to.days]), [['56', '초4', '월수'], ['08', '초6', '화목']]);
  assert.deepEqual(d.missing, [{ no: '43', name: '이지아' }]);
  assert.equal(C.normalizeDays('수, 월 금'), '월수금');
});

test('카드 인쇄: 그 날짜 요일 등원생, 4장씩 나누기', () => {
  const roster = [
    { no: '56', name: '김도윤', days: '월수금', status: '재원' },
    { no: '07', name: '박하늘', days: '화목', status: '재원' },
    { no: '12', name: '최퇴원', days: '화', status: '퇴원' },
    { no: '03', name: '한별', days: '화', status: '재원' },
    { no: '20', name: '요일없음', days: '', status: '재원' },
  ];
  assert.deepEqual(C.studentsOn(roster, '2026-10-20').map((s) => s.no), ['03', '07']); // 화요일
  assert.deepEqual(C.studentsOn(roster, '2026-10-19').map((s) => s.no), ['56']);
  assert.deepEqual(C.studentsOn(roster, ''), []);
  assert.deepEqual(C.toSheets([1, 2, 3, 4, 5], 4), [[1, 2, 3, 4], [5, null, null, null]]);
  assert.deepEqual(C.toSheets([], 4), []);
  assert.equal(C.nextClassDate('화목', '2026-10-20'), '2026-10-22'); // 화 → 목
  assert.equal(C.nextClassDate('화목', '2026-10-22'), '2026-10-27'); // 목 → 다음 주 화
  assert.equal(C.nextClassDate('화', '2026-10-20'), '2026-10-27'); // 주 1회 → 일주일 뒤
  assert.equal(C.nextClassDate('', '2026-10-20'), '');
});

/* ---------- 2단계: 기간 · 집계 ---------- */
const rec = (d, patch) => ({ ...base(), 수업일: d, ...patch });

test('기간 단추', () => {
  assert.deepEqual(C.periodRange('2w', '2026-10-10'), { from: '2026-09-27', to: '2026-10-10' });
  assert.deepEqual(C.periodRange('month', '2026-10-10'), { from: '2026-10-01', to: '2026-10-10' });
  assert.deepEqual(C.periodRange('lastMonth', '2026-03-05'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(C.periodRange('all', '2026-10-10'), { from: '', to: '' });
  assert.ok(C.inPeriod('2026-10-01', { from: '2026-10-01', to: '' }));
  assert.ok(!C.inPeriod('2026-09-30', { from: '2026-10-01', to: '' }));
  assert.equal(C.weekday('2026-10-09'), '금');
});

test('과제 완료율: (완료 + 50% 이상×0.7 + 50% 미만×0.3) / 과제 없음을 뺀 횟수, 두고 옴은 설정대로', () => {
  const rs = ['완료', '50% 이상', '50% 미만', '안 함', '두고 옴', '과제 없음', ''].map((x, i) => rec(`2026-10-0${i + 1}`, { 지난과제: x }));
  const zero = C.homework(rs, '안 함과 같이(×0)');
  assert.equal(zero.denom, 5);
  assert.ok(Math.abs(zero.rate - 2 / 5) < 1e-9);
  assert.ok(Math.abs(C.homework(rs, '절반만 인정(×0.5)').rate - 2.5 / 5) < 1e-9);
  assert.ok(Math.abs(C.homework(rs, '미완과 같이(×0.5)').rate - 2.5 / 5) < 1e-9);
  const ex = C.homework(rs, '계산에서 제외');
  assert.equal(ex.denom, 4);
  assert.ok(Math.abs(ex.rate - 2 / 4) < 1e-9);
  // 옛 기록의 미완은 ×0.5
  assert.equal(C.homework([rec('2026-10-01', { 지난과제: '미완' }), rec('2026-10-02', { 지난과제: '완료' })], '').rate, 1.5 / 2);
  assert.equal(C.homework([rec('2026-10-01', { 지난과제: '과제 없음' })], '').rate, null);
});

test('학생 기간 집계', () => {
  const rs = [
    rec('2026-10-06', { 출결: '정규', 단계: '개념', 학습주안점: '계산 실수 교정', 추가포인트: '3', '수업시간(분)': '90' }),
    rec('2026-10-01', { 출결: '정규', 단계: '개념', 학습주안점: '계산 실수; 조건 놓침', 추가포인트: '0', '수업시간(분)': '80' }),
    rec('2026-10-08', { 출결: '결강', 단계: '', 학습주안점: '', 추가포인트: '', '수업시간(분)': '', 지난과제: '' }),
    rec('2026-10-09', { 출결: '보강', 단계: '유형; 개념', 학습주안점: '', 추가포인트: '9', '수업시간(분)': '55' }),
  ];
  const s = C.summarize(rs, { leftMode: '안 함과 같이(×0)' });
  assert.equal(s.count, 4);
  assert.deepEqual(s.attendance, { 정규: 2, 보강: 1, 결강: 1 });
  assert.equal(s.points, 12);
  assert.equal(s.avgMinutes, 75);
  assert.deepEqual(s.errors, [['계산 실수 교정', 2], ['문제 읽기(조건 찾기)', 1]]); // 옛 보기 이름도 새 이름으로 센다
  assert.deepEqual(s.stages, [{ date: '2026-10-01', stage: '개념', count: 2 }, { date: '2026-10-09', stage: '개념·유형', count: 1 }]);
  assert.equal(s.from, '2026-10-01');
  assert.equal(s.homework.denom, 3);
});

test('CSV 내보내기 형식', () => {
  assert.equal(C.toCsv([['a', 'b,c'], ['줄\n바꿈', '"인용"']]), '﻿a,"b,c"\r\n"줄\n바꿈","""인용"""\r\n');
});

/* ---------- 학부모 2주 리포트 ---------- */

// 샘플 학생 김하린 (화·목 16:00). 10/22·10/29 지각, 10/27은 5분 늦어 지각 아님
const HARIN = [
  { 수업일: '2026-10-20', 출결: '정규', 등원: '16:00', 하원: '17:30', 지난과제: '완료', 단계: '유형', 학습주안점: '문제 읽기(조건 찾기)', 추가포인트: '3', 오늘진도범위: '디딤돌(3)[64~69]○; 디딤돌(3)[70~71]△' },
  { 수업일: '2026-10-22', 출결: '정규', 등원: '16:12', 하원: '17:40', '수업시간(분)': '88', 지난과제: '50% 이상', 단계: '유형; 단원마무리', 학습주안점: '계산 실수 교정; 풀이 과정 서술', 추가포인트: '0', 오늘진도범위: '디딤돌(3)[74~79]○' },
  { 수업일: '2026-10-27', 출결: '정규', 등원: '16:05', 하원: '17:30', 지난과제: '완료', 단계: '교재오답; 평가', 학습주안점: '풀이 과정 서술', 추가포인트: '6', 오늘진도범위: '교재오답(3)[~Step3]○; 단원Test(3)[]○' },
  { 수업일: '2026-10-29', 출결: '정규', 등원: '16:20', 하원: '17:45', 지난과제: '50% 미만', 단계: '개념', 학습주안점: '개념 재학습/오개념 수정; 계산 실수 교정', 추가포인트: '3', 오늘진도범위: '디딤돌(4)[84~89]△' },
];

test('등원 시각: 적는 방식이 달라도 같은 값으로', () => {
  assert.deepEqual(C.parseTimes('목 4:30, 화16:00'), { 목: '04:30', 화: '16:00' });
  assert.equal(C.timesText(C.parseTimes('목16:30 화 16:00')), '화 16:00, 목 16:30');
  assert.deepEqual(C.parseTimes(''), {});
});

test('지각: 정해진 시각 + 5분을 넘긴 날만, 결강·시각 없는 요일은 빼고', () => {
  const late = C.lateList(HARIN, '화 16:00, 목 16:00');
  assert.deepEqual(late.map((x) => [x.date, x.in, x.out, x.late]), [['2026-10-22', '16:12', '17:40', 12], ['2026-10-29', '16:20', '17:45', 20]]);
  assert.equal(C.lateList(HARIN, '화 16:00').length, 0); // 목요일 시각이 없으면 목요일은 세지 않음
  assert.equal(C.lateList([{ 수업일: '2026-10-22', 출결: '결강', 등원: '', 하원: '' }], '목 16:00').length, 0);
  assert.equal(C.lateList([{ 수업일: '2026-10-22', 출결: '정규', 등원: '16:06', 하원: '17:30' }], '목 16:00').length, 1);
});

test('부르는 이름: 받침이 있으면 이', () => {
  assert.equal(C.callName('김하린'), '하린이');
  assert.equal(C.callName('박서아'), '서아');
  assert.equal(C.callName('남궁민수'), '남궁민수');
});

test('학부모 리포트: 출석 n/n회 뒤에 지각 횟수, 지각한 날 등·하원 시각과 수업시간', () => {
  const text = C.parentReport({ name: '김하린', times: '화 16:00, 목 16:00', grade: '초5' }, HARIN, { from: '2026-10-16', to: '2026-10-29', note: '3단원을 잘 마쳤어요.' });
  const lines = text.split('\n');
  assert.equal(lines[0], '[지음수학] 하린이 2주 학습 리포트 (10/16~10/29)');
  // 10/22는 기록의 수업시간(분), 10/29는 기록에 없어 등·하원으로 계산
  assert.deepEqual(lines.slice(2, 5), ['📅 출석 4/4회 · 지각 2회', ' · 10/22(목) 등원 16:12 · 하원 17:40 (88분)', ' · 10/29(목) 등원 16:20 · 하원 17:45 (85분)']);
  assert.ok(text.includes(' · 10/20(화) 유형 연습\n    └ 디딤돌 3단원(합동과 대칭)\n'));
  assert.ok(text.includes(' · 10/27(화) 오답 다시 풀기, 단원 평가\n    └ 오답 학습지 3단원(합동과 대칭), 단원 Test 3단원(합동과 대칭)\n'));
  assert.ok(text.includes(' · 10/29(목) 개념 학습\n    └ 디딤돌 4단원(소수의 곱셈)\n'));
  // 학년을 모르면 단원 번호만
  assert.ok(C.parentReport({ name: '김하린' }, HARIN).includes(' · 10/20(화) 유형 연습\n    └ 디딤돌 3단원\n'));
  assert.ok(lines.includes('✏️ 과제 완료율 75% (완료 2회, 50% 이상 1회, 50% 미만 1회)'));
  assert.ok(lines.includes('⭐ 추가 포인트 12점'));
  assert.ok(lines.includes('🎯 집중해서 연습한 것: 계산 실수 줄이기, 풀이 과정 쓰기'));
  assert.ok(lines.includes('3단원을 잘 마쳤어요.'));
  // 지각이 없으면 '지각 없음', 등원 시각을 모르면 지각 줄을 아예 빼기
  assert.ok(C.parentReport({ name: '김하린', times: '화 16:30, 목 16:30' }, HARIN).includes('📅 출석 4/4회 · 지각 없음'));
  const noTimes = C.parentReport({ name: '김하린', times: '' }, [...HARIN, { 수업일: '2026-10-30', 출결: '결강' }]);
  assert.ok(noTimes.includes('📅 출석 4/5회\n') && !noTimes.includes('지각'));
  assert.ok(noTimes.includes('📅 출석 4/5회\n · 10/30(금) 결강\n')); // 사유가 없으면 날짜만
  assert.ok(text.endsWith('수업 진행과 관련하여 궁금하신 점은 언제든 편하게 말씀해 주세요 :)'));
});

test('학부모 리포트: 결강한 날과 사유(지음쌤 톡톡)는 출석 줄 바로 아래, 지각 줄보다 먼저', () => {
  const recs = [...HARIN, { 수업일: '2026-10-24', 출결: '결강', 학습태도: '가족 여행' }];
  const lines = C.parentReport({ name: '김하린', times: '화 16:00, 목 16:00', grade: '초5' }, recs).split('\n');
  assert.deepEqual(lines.slice(2, 5), ['📅 출석 4/5회 · 지각 2회', ' · 10/24(토) 결강 (가족 여행)', ' · 10/22(목) 등원 16:12 · 하원 17:40 (88분)']);
});

test('이번 2주 흐름: 수업일마다 교재를 모두, 단원 있는 같은 교재가 있으면 단원 없는 이름은 뺀다', () => {
  const recs = [{ 수업일: '2026-10-23', 출결: '정규', 단계: '단원마무리', 오늘진도범위: '자료집(3)[1~2]○; 자료집(4)[3]; 자료집()[5]', 추가포인트범위: '' },
    { 수업일: '2026-10-24', 출결: '정규', 단계: '', 오늘진도범위: '', 추가포인트범위: '문장제()[10]○' }];
  assert.deepEqual(C.flowLines(recs, { grade: '초5' }), ['10/23(금) 단원 마무리\n    └ 자료집 3단원(합동과 대칭), 자료집 4단원(소수의 곱셈)', '10/24(토)\n    └ 문장제']);
  // 지난 과제 범위는 ○·△만 (표시 없는 건 안 한 것)
  const p = [{ 수업일: '2026-10-29', 출결: '정규', 단계: '개념', 지난과제범위: '자료집(3)[1~4]△; 연산(2)[5]', 오늘진도범위: '디딤돌(4)[84~89]△' }];
  assert.deepEqual(C.flowLines(p, { grade: '초5' }), ['10/29(목) 개념 학습\n    └ 자료집 3단원(합동과 대칭), 디딤돌 4단원(소수의 곱셈)']);
  const t = [{ 수업일: '2026-10-30', 출결: '정규', 단계: '평가', 오늘진도범위: '주간Test(2)[]○' }];
  assert.deepEqual(C.flowLines(t, { grade: '초5' }), ['10/30(금) 단원 평가\n    └ 주간 Test 2단원(분수의 곱셈)']);
});

test('단원 이름: 3~6학년, 수업일 기준 학기(2~7월 1학기) 또는 학생별로 고정한 학기', () => {
  assert.equal(C.unitName('초5', '2026-10-20', '3'), '합동과 대칭');
  assert.equal(C.unitName('초5', '2026-07-31', '3'), '대응 관계');
  assert.equal(C.unitName('초5', '2026-08-01', '3'), '합동과 대칭');
  assert.equal(C.unitName('초5', '2027-01-31', '3'), '합동과 대칭');
  assert.equal(C.unitName('초5', '2027-02-01', '3'), '대응 관계');
  assert.equal(C.unitName('초5', '2026-10-20', '3', '1학기'), '대응 관계'); // 선행·복습으로 학기를 고정
  assert.equal(C.unitName('초6', '2026-10-20', '6'), '원기둥, 원뿔, 구');
  assert.equal(C.unitName('초3', '2026-03-02', '1'), '덧셈과 뺄셈');
  assert.equal(C.unitName('초2', '2026-03-02', '1'), ''); // 1~2학년은 데이터 없음
  assert.equal(C.unitName('중1', '2026-03-02', '1'), '');
  assert.equal(C.unitName('초5', '2026-10-20', '7'), '');
  assert.deepEqual(Object.keys(C.UNITS), ['3', '4', '5', '6']);
  Object.values(C.UNITS).forEach((g) => [1, 2].forEach((t) => assert.equal(g[t].length, 6)));
});

test('지음쌤 한마디 추천: 단원 마무리·평가 점수·새 단원 → 잘한 점 → 다음 2주 목표', () => {
  const recs = HARIN.map((r) => ({ ...r, 학습태도: r.수업일 === '2026-10-27' ? '3단원 평가 88점! 틀린 2문제 스스로 고쳤어요' : '' }));
  assert.equal(C.suggestNote({ name: '김하린', grade: '초5', times: '화 16:00, 목 16:00' }, recs),
    '3단원(합동과 대칭)을 마무리하고 단원 평가에서 88점을 받았어요. 이어서 4단원(소수의 곱셈) 개념 학습을 시작했어요. '
    + '추가 문제에도 적극적으로 도전해 포인트 12점을 모았어요. 다음 2주는 계산 실수 줄이기, 과제 끝까지 해 오기와 제시간에 등원하기를 목표로 할게요. '
    + '집에서도 과제 마무리를 한 번씩 챙겨봐 주세요.');
  // 과제를 잘 해 오고 평가가 없으면: 진도 문장 → 과제 칭찬 → 주안점 목표
  const good = [
    { 수업일: '2026-10-20', 출결: '정규', 지난과제: '완료', 단계: '유형', 진행률: '75~100%', 학습주안점: '풀이 과정 서술', 추가포인트: '0', 오늘진도범위: '디딤돌(3)[64~69]○' },
    { 수업일: '2026-10-22', 출결: '정규', 지난과제: '완료', 단계: '유형', 진행률: '75~100%', 학습주안점: '', 추가포인트: '3', 오늘진도범위: '디딤돌(3)[70~75]○' },
  ];
  assert.equal(C.suggestNote({ name: '박서아', grade: '초4' }, good),
    '계획한 진도를 꾸준히 잘 나가고 있어요. 과제도 빠짐없이 해 와서 칭찬해 주고 싶어요. 다음 2주는 풀이 과정 꼼꼼히 쓰기를 목표로 할게요.');
  assert.equal(C.suggestNote({ name: '박서아' }, []), '');
});
