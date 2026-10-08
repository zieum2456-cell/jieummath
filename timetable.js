/*
 * 수업 시간표 계산 로직 (브라우저와 Node 테스트에서 함께 사용)
 *
 * student = {
 *   id, name,
 *   times: { 1: { in: '15:30', out: '17:30' }, ... }  // 요일별 등원·하원 시각 (1=월 ... 6=토)
 * }
 *
 * 시간표 칸: 15:00~20:00는 30분 단위, 20:00~22:00는 1시간 단위.
 * 칸마다 높이가 같으므로 시각 → 세로 위치는 구간별로 비례해서 계산한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Timetable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAYS = [
    { day: 1, label: '월' },
    { day: 2, label: '화' },
    { day: 3, label: '수' },
    { day: 4, label: '목' },
    { day: 5, label: '금' },
    { day: 6, label: '토' },
  ];

  const START = 15 * 60; // 15:00
  const SPLIT = 20 * 60; // 20:00부터 1시간 단위
  const END = 22 * 60; // 22:00

  function buildSlots() {
    const slots = [];
    for (let t = START; t < SPLIT; t += 30) slots.push({ start: t, end: t + 30 });
    for (let t = SPLIT; t < END; t += 60) slots.push({ start: t, end: t + 60 });
    return slots;
  }
  const SLOTS = buildSlots();

  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function fmtTime(min) {
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  }

  // 시각 → 칸 단위 세로 위치 (0 = 15:00 칸 위쪽, SLOTS.length = 22:00)
  function timeToRow(min) {
    const t = Math.min(Math.max(min, START), END);
    if (t <= SPLIT) return (t - START) / 30;
    return (SPLIT - START) / 30 + (t - SPLIT) / 60;
  }

  // 등원·하원 시각 확인. 문제가 없으면 null, 있으면 안내 문구
  function validateTime(t) {
    if (!t || (!t.in && !t.out)) return null;
    const a = parseTime(t.in);
    const b = parseTime(t.out);
    if (a == null) return '등원 시각을 입력해 주세요.';
    if (b == null) return '하원 시각을 입력해 주세요.';
    if (b <= a) return '하원 시각이 등원 시각보다 늦어야 합니다.';
    return null;
  }

  // 그 요일에 오는 학생들을 시간 막대로 만들고, 겹치지 않게 세로줄(lane)을 나눈다
  function buildDay(students, day) {
    const entries = [];
    for (const s of students || []) {
      const t = s.times && s.times[day];
      if (!t || validateTime(t)) continue;
      const a = parseTime(t.in);
      const b = parseTime(t.out);
      if (a == null || b == null) continue;
      entries.push({ id: s.id, name: s.name, in: a, out: b });
    }
    entries.sort((x, y) => x.in - y.in || x.out - y.out || String(x.name).localeCompare(String(y.name), 'ko'));

    const laneEnds = [];
    for (const e of entries) {
      let lane = laneEnds.findIndex((end) => end <= e.in);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = e.out;
      e.lane = lane;
      e.top = timeToRow(e.in);
      e.bottom = timeToRow(e.out);
    }

    const counts = SLOTS.map((slot) => entries.filter((e) => e.in < slot.end && e.out > slot.start).length);
    return { entries, lanes: laneEnds.length, counts };
  }

  return { DAYS, SLOTS, START, SPLIT, END, parseTime, fmtTime, timeToRow, validateTime, buildDay };
});
