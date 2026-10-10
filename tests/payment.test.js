const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../payment.js');

// 월·수 수업, 2시간, 8회 / 2026-10-05(월) 시작
const base = () => ({
  name: '김지음',
  minutes: 120,
  cycle: 8,
  days: [1, 3],
  startDate: '2026-10-05',
  events: [],
  history: [],
});

test('예외 없음: 8회 = 4주', () => {
  const r = P.computeCycle(base(), [], '2026-10-05');
  assert.equal(r.sessions.length, 8);
  assert.equal(r.lastDate, '2026-10-28');
  assert.equal(r.nextDate, '2026-11-02');
  assert.equal(r.done, 1);
  assert.equal(P.buildMessage(base(), r), '120분 * 8회(주2일)\n수업 시작일: 2026.11.02');
});

test('휴강·이월 결강은 결제일을 미루고, 차감 결강은 미루지 않는다', () => {
  const s = base();
  s.events = [
    { type: '결강', date: '2026-10-12', reason: '병결', counted: false },
    { type: '결강', date: '2026-10-14', reason: '무단', counted: true },
  ];
  const holidays = [{ date: '2026-10-07', reason: '학원 휴무' }];
  const r = P.computeCycle(s, holidays);
  assert.equal(r.sessions.length, 8);
  // 휴강 1 + 이월 결강 1 → 2회 밀림
  assert.equal(r.lastDate, '2026-11-04');
  assert.equal(r.nextDate, '2026-11-09');
  assert.ok(r.sessions.some((x) => x.date === '2026-10-14' && x.kind === '결강'));
  assert.equal(
    P.buildMessage(s, r),
    '120분 * 8회(주2일)\n수업 시작일: 2026.11.09\n--\n휴강: 10/07(학원 휴무)\n결강: 10/12(병결), 10/14(무단, 회차 차감)'
  );
});

test('대체수업은 원래 날짜 대신 옮긴 날짜를 회차로 센다', () => {
  const s = base();
  s.events = [{ type: '대체', date: '2026-10-12', toDate: '2026-10-17', reason: '학교 행사' }];
  const r = P.computeCycle(s, []);
  assert.equal(r.lastDate, '2026-10-28');
  assert.ok(!r.sessions.some((x) => x.date === '2026-10-12'));
  assert.ok(r.sessions.some((x) => x.date === '2026-10-17' && x.kind === '대체'));
  assert.match(P.buildMessage(s, r), /대체수업: 10\/12\(학교 행사\) → 10\/17$/);
});

test('수업 요일이 아닌 전체 휴강은 영향 없음', () => {
  const r = P.computeCycle(base(), [{ date: '2026-10-09', reason: '한글날' }]);
  assert.equal(r.lastDate, '2026-10-28');
  assert.equal(r.exceptions.length, 0);
});

test('마지막 회차 뒤 휴강도 메시지에 포함되고 다음 시작일을 미룬다', () => {
  const r = P.computeCycle(base(), [{ date: '2026-11-02', reason: '휴무' }]);
  assert.equal(r.nextDate, '2026-11-04');
  assert.equal(r.exceptions.length, 1);
});

test('결제일 기준 설정', () => {
  const r = P.computeCycle(base(), []);
  assert.equal(P.dueDate(r, {}), '2026-11-02');
  assert.equal(P.dueDate(r, { dueBasis: 'last' }), '2026-10-28');
});

test('머리말/맺음말 치환', () => {
  const r = P.computeCycle(base(), []);
  const msg = P.buildMessage(base(), r, { prefix: '{이름} 학부모님 안녕하세요.', suffix: '결제일: {결제일}' });
  assert.equal(msg, '김지음 학부모님 안녕하세요.\n\n120분 * 8회(주2일)\n수업 시작일: 2026.11.02\n\n결제일: 2026.11.02');
});

test('결제 완료 → 다음 회차, 되돌리기', () => {
  const s = base();
  const r = P.computeCycle(s, []);
  const s2 = P.advance(s, r, '2026-10-28');
  assert.equal(s2.startDate, '2026-11-02');
  assert.equal(s2.history.length, 1);
  assert.equal(P.computeCycle(s2, []).lastDate, '2026-11-25');
  assert.equal(P.undoAdvance(s2).startDate, '2026-10-05');
});

test('시간 표기', () => {
  assert.equal(P.formatMinutes(90), '90분');
  assert.equal(P.formatMinutes(50), '50분');
  assert.equal(P.formatMinutes(180), '180분');
});

test('결제 기준 표기', () => {
  assert.equal(P.cycleLabel(12), '12회(주3일)');
  assert.equal(P.cycleLabel(8), '8회(주2일)');
});

test('보충수업은 회차를 1회 추가하고 메시지에 대체수업 다음 줄로 표시된다', () => {
  const s = base();
  s.events = [
    { type: '대체', date: '2026-10-12', toDate: '2026-10-17', reason: '학교 행사' },
    { type: '보충', date: '2026-10-10', reason: '' },
    { type: '보충', date: '2026-10-24', reason: '진도 보강' },
  ];
  const r = P.computeCycle(s, []);
  // 보충 2회 추가 → 정규 수업 2회 일찍 끝남
  assert.equal(r.lastDate, '2026-10-24');
  assert.equal(r.nextDate, '2026-10-26');
  assert.ok(r.sessions.some((x) => x.date === '2026-10-10' && x.kind === '보충'));
  assert.match(P.buildMessage(s, r), /대체수업: 10\/12\(학교 행사\) → 10\/17\n보충: 10\/10, 10\/24\(진도 보강\)$/);
});

test('원비 입력 해석', () => {
  assert.equal(P.parseFee('35만'), 350000);
  assert.equal(P.parseFee('35'), 350000);
  assert.equal(P.parseFee('32.5만'), 325000);
  assert.equal(P.parseFee('35만 5천'), 355000);
  assert.equal(P.parseFee('350,000원'), 350000);
  assert.equal(P.parseFee(''), null);
  assert.ok(Number.isNaN(P.parseFee('삼십오만')));
  assert.equal(P.feeToInput(350000), '35만');
  assert.equal(P.feeToInput(null), '');
});

test('전체 휴강에서 제외된 학생은 정상 수업', () => {
  const s = { ...base(), id: 'kim' };
  const holidays = [{ date: '2026-10-07', reason: '학원 휴무', exclude: ['kim'] }];
  assert.equal(P.computeCycle(s, holidays).lastDate, '2026-10-28');
  assert.equal(P.computeCycle({ ...s, id: 'lee' }, holidays).lastDate, '2026-11-02');
});

test('학생번호 정리: 한 자리는 앞에 0을 붙이고, 숫자가 아니면 null', () => {
  assert.equal(P.normalizeNo(''), '');
  assert.equal(P.normalizeNo(' 5 '), '05');
  assert.equal(P.normalizeNo('56'), '56');
  assert.equal(P.normalizeNo('123'), null);
  assert.equal(P.normalizeNo('5a'), null);
});

test('진도카드용 명단 텍스트: 번호 순, 번호 없는 학생 제외', () => {
  const students = [
    { no: '56', name: '김도윤', grade: '초4' },
    { no: '', name: '이번호없음', grade: '초5' },
    { no: '07', name: '박지아' },
  ];
  assert.equal(P.rosterText(students), '07\t박지아\t\n56\t김도윤\t초4');
});
