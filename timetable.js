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

  // 학생의 요일별 [등원, 하원] (분). 입력이 잘못된 요일은 빼고
  function intervals(student) {
    const out = [];
    for (const { day } of DAYS) {
      const t = student.times && student.times[day];
      if (!t || validateTime(t)) continue;
      const a = parseTime(t.in);
      const b = parseTime(t.out);
      if (a != null && b != null) out.push({ day, in: a, out: b });
    }
    return out;
  }

  // 정해진 순서대로 학생마다 "모든 요일에서 겹치지 않는" 가장 왼쪽 세로줄을 준다
  function colorLanes(order) {
    const lane = {};
    const used = []; // used[줄][요일] = [[등원, 하원], ...]
    for (const { id, ivs } of order) {
      let l = 0;
      while (used[l] && !ivs.every((v) => (used[l][v.day] || []).every(([a, b]) => v.out <= a || b <= v.in))) l++;
      used[l] = used[l] || {};
      ivs.forEach((v) => (used[l][v.day] = used[l][v.day] || []).push([v.in, v.out]));
      lane[id] = l;
    }
    return { lane, count: used.length };
  }

  // 같은 학생은 모든 요일에서 같은 세로줄(열)에 오도록 줄을 정한다.
  // 여러 순서로 배치해 보고 줄 수가 가장 적은 것을 고른다 (결과는 항상 같음)
  function assignLanes(students) {
    const list = (students || []).map((s) => {
      const ivs = intervals(s);
      return {
        id: s.id,
        name: String(s.name || ''),
        ivs,
        days: ivs.length,
        total: ivs.reduce((sum, v) => sum + v.out - v.in, 0),
        first: ivs.length ? Math.min(...ivs.map((v) => v.in)) : Infinity,
      };
    }).filter((x) => x.ivs.length);
    const tie = (a, b) => a.name.localeCompare(b.name, 'ko') || String(a.id).localeCompare(String(b.id));
    const orders = [
      [...list].sort((a, b) => b.days - a.days || b.total - a.total || tie(a, b)),
      [...list].sort((a, b) => b.total - a.total || tie(a, b)),
      [...list].sort((a, b) => a.first - b.first || b.total - a.total || tie(a, b)),
    ];
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 30; i++) {
      const o = [...orders[0]];
      for (let j = o.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [o[j], o[k]] = [o[k], o[j]];
      }
      orders.push(o);
    }
    let best = null;
    for (const o of orders) {
      const r = colorLanes(o);
      if (!best || r.count < best.count) best = r;
    }
    return best;
  }

  // 그 요일에 오는 학생들을 시간 막대로 만든다. 세로줄은 assignLanes 결과(요일 공통)를 따른다
  function buildDay(students, day, lanes = assignLanes(students)) {
    const entries = [];
    for (const s of students || []) {
      const v = intervals(s).find((x) => x.day === day);
      if (!v) continue;
      entries.push({ id: s.id, name: s.name, in: v.in, out: v.out, lane: lanes.lane[s.id], top: timeToRow(v.in), bottom: timeToRow(v.out) });
    }
    entries.sort((x, y) => x.in - y.in || x.lane - y.lane);
    const counts = SLOTS.map((slot) => entries.filter((e) => e.in < slot.end && e.out > slot.start).length);
    return { entries, lanes: lanes.count, counts };
  }

  return { DAYS, SLOTS, START, SPLIT, END, parseTime, fmtTime, timeToRow, validateTime, assignLanes, buildDay };
});
