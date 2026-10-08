const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../timetable.js');

test('칸 구성: 15~20시 30분 단위 10칸 + 20~22시 1시간 단위 2칸', () => {
  assert.equal(T.SLOTS.length, 12);
  assert.equal(T.fmtTime(T.SLOTS[0].start), '15:00');
  assert.equal(T.fmtTime(T.SLOTS[9].start), '19:30');
  assert.deepEqual(T.SLOTS.slice(10).map((s) => [T.fmtTime(s.start), T.fmtTime(s.end)]), [['20:00', '21:00'], ['21:00', '22:00']]);
});

test('시각 → 세로 위치는 구간별로 비례', () => {
  assert.equal(T.timeToRow(T.parseTime('15:00')), 0);
  assert.equal(T.timeToRow(T.parseTime('16:15')), 2.5);
  assert.equal(T.timeToRow(T.parseTime('20:00')), 10);
  assert.equal(T.timeToRow(T.parseTime('20:30')), 10.5);
  assert.equal(T.timeToRow(T.parseTime('22:00')), 12);
  assert.equal(T.timeToRow(T.parseTime('14:00')), 0); // 범위 밖은 끝에 맞춤
});

test('시각 확인', () => {
  assert.equal(T.validateTime({ in: '', out: '' }), null);
  assert.equal(T.validateTime({ in: '15:00', out: '17:00' }), null);
  assert.ok(T.validateTime({ in: '15:00', out: '' }));
  assert.ok(T.validateTime({ in: '17:00', out: '15:00' }));
});

test('요일별 학생 배치: 겹치면 다른 줄, 겹치지 않으면 같은 줄 재사용', () => {
  const students = [
    { id: 'a', name: '가', times: { 1: { in: '15:00', out: '17:00' } } },
    { id: 'b', name: '나', times: { 1: { in: '16:00', out: '18:00' }, 3: { in: '15:00', out: '16:00' } } },
    { id: 'c', name: '다', times: { 1: { in: '17:00', out: '20:30' } } },
    { id: 'd', name: '라', times: { 1: { in: '18:00', out: '17:00' } } }, // 잘못된 입력은 제외
  ];
  const d = T.buildDay(students, 1);
  assert.equal(d.entries.length, 3);
  assert.equal(d.lanes, 2);
  const lane = Object.fromEntries(d.entries.map((e) => [e.name, e.lane]));
  assert.notEqual(lane['가'], lane['나']);
  assert.notEqual(lane['나'], lane['다']);
  assert.equal(lane['가'], lane['다']);
  // 15:00 1명, 16:00 2명, 17:00 2명(나·다), 20:00~21:00 1명(다), 21:00~ 0명
  assert.equal(d.counts[0], 1);
  assert.equal(d.counts[2], 2);
  assert.equal(d.counts[4], 2);
  assert.equal(d.counts[10], 1);
  assert.equal(d.counts[11], 0);
  assert.equal(T.buildDay(students, 3).entries.length, 1);
  assert.equal(T.buildDay(students, 6).entries.length, 0);
});

test('같은 학생은 모든 요일에서 같은 줄, 같은 요일 같은 줄끼리는 겹치지 않음', () => {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const students = Array.from({ length: 30 }, (_, i) => {
    const times = {};
    const st = 15 * 60 + Math.floor(r() * 8) * 30;
    const len = [60, 90, 120][Math.floor(r() * 3)];
    for (const day of [1, 2, 3, 4, 5, 6]) {
      if (r() < 0.5) continue;
      const s = r() < 0.6 ? st : 15 * 60 + Math.floor(r() * 8) * 30;
      times[day] = { in: T.fmtTime(s), out: T.fmtTime(Math.min(s + len, T.END)) };
    }
    return { id: 's' + i, name: '학생' + i, times };
  });
  const lanes = T.assignLanes(students);
  const seen = {};
  let maxPerDay = 0;
  for (const { day } of T.DAYS) {
    const d = T.buildDay(students, day, lanes);
    assert.equal(d.lanes, lanes.count);
    for (const e of d.entries) {
      if (e.id in seen) assert.equal(e.lane, seen[e.id], e.name);
      seen[e.id] = e.lane;
      for (const o of d.entries) {
        if (o !== e && o.lane === e.lane) assert.ok(o.out <= e.in || e.out <= o.in, `${e.name}·${o.name} 겹침`);
      }
    }
    maxPerDay = Math.max(maxPerDay, Math.max(0, ...d.counts));
  }
  assert.ok(lanes.count >= maxPerDay);
  assert.deepEqual(T.assignLanes(students), lanes); // 항상 같은 결과
});
