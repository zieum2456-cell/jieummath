/*
 * 결제일 계산 / 안내 메시지 생성 로직
 * 브라우저(window.Payment)와 Node(require) 양쪽에서 사용할 수 있다.
 *
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다룬다.
 *
 * student = {
 *   id, name,
 *   no: '56',                // 학생번호 (숫자 두 자리, 진도 카드와 연결하는 번호, 없으면 '')
 *   grade: '중1',            // 학년 (GRADES 중 하나, 없으면 '')
 *   minutes: 120,            // 회당 수업시간(분)
 *   cycle: 12 | 8,           // 결제 기준 회차
 *   days: [1, 3, 5],         // 등원 요일 (0=일 ... 6=토)
 *   startDate: '2026-10-01', // 이번 회차 수업 시작일
 *   events: [
 *     { id, type: '휴강', date, reason },
 *     { id, type: '결강', date, reason, counted: false }, // counted=true 면 회차 차감(이월 안 함)
 *     { id, type: '대체', date, toDate, reason },          // date 수업을 toDate 로 옮김
 *     { id, type: '보충', date, reason },                  // date 에 회차 1회 추가
 *   ],
 *   history: [{ start, last, next, paidAt }],
 * }
 * holidays = [{ id, date, reason, exclude: [studentId] }]  // 전체 휴강(공휴일, 방학 등) - exclude 학생 빼고 모두 적용
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Payment = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const GRADES = ['초3', '초4', '초5', '초6', '중1', '중2', '중3', '고1', '고2', '고3'];
  const MAX_DAYS = 3660; // 무한 루프 방지 (약 10년)

  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toISO(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(s, n) {
    const dt = parseDate(s);
    dt.setDate(dt.getDate() + n);
    return toISO(dt);
  }

  function weekday(s) {
    return parseDate(s).getDay();
  }

  function today() {
    return toISO(new Date());
  }

  function diffDays(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  function fmtMD(s) {
    const [, m, d] = s.split('-');
    return `${m}/${d}`;
  }

  function fmtDot(s) {
    return s.split('-').join('.');
  }

  function fmtMDW(s) {
    return `${fmtMD(s)}(${WEEKDAYS[weekday(s)]})`;
  }

  function formatMinutes(min) {
    return `${Number(min) || 0}분`;
  }

  /**
   * 원비 입력값을 원 단위 숫자로 바꾼다.
   * '35만', '35', '35.5만', '35만 5천', '350,000원' 모두 허용. 숫자만 쓰면 1만 미만은 만 원 단위로 본다.
   * 비어 있으면 null, 해석할 수 없으면 NaN.
   */
  function parseFee(text) {
    const s = String(text ?? '').replace(/[\s,원]/g, '');
    if (!s) return null;
    const m = s.match(/^(\d+(?:\.\d+)?)만(?:(\d+(?:\.\d+)?)(천)?)?$/);
    if (m) return Math.round(Number(m[1]) * 10000 + (m[2] ? Number(m[2]) * (m[3] ? 1000 : 1) : 0));
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Math.round(n < 10000 ? n * 10000 : n);
    }
    return NaN;
  }

  /** 원 단위 원비를 입력란용 '35만' 형태로 */
  function feeToInput(fee) {
    if (fee == null || fee === '') return '';
    return `${Number(fee) / 10000}만`;
  }

  /** 결제 기준 표기: 12회(주3일), 8회(주2일) */
  const CYCLE_LABELS = { 12: '12회(주3일)', 8: '8회(주2일)' };
  function cycleLabel(cycle) {
    return CYCLE_LABELS[cycle] || `${cycle}회`;
  }

  /** 특정 날짜의 수업/예외 정보를 돌려준다. */
  function dayInfo(student, holidays, date) {
    const sessions = [];
    const exceptions = [];
    const events = student.events || [];

    // 다른 날에서 이 날로 옮겨온 대체수업
    for (const ev of events) {
      if (ev.type === '대체' && ev.toDate === date) {
        sessions.push({ date, kind: '대체', from: ev.date, reason: ev.reason || '' });
      }
    }

    if ((student.days || []).includes(weekday(date))) {
      const holiday = (holidays || []).find((h) => h.date === date && !(h.exclude || []).includes(student.id));
      const own = (type) => events.find((ev) => ev.type === type && ev.date === date);
      const closed = own('휴강');
      const moved = own('대체');
      const absent = own('결강');

      if (holiday || closed) {
        const src = closed || holiday;
        exceptions.push({ type: '휴강', date, reason: src.reason || '' });
      } else if (moved) {
        exceptions.push({ type: '대체', date, toDate: moved.toDate, reason: moved.reason || '' });
      } else if (absent) {
        exceptions.push({ type: '결강', date, reason: absent.reason || '', counted: !!absent.counted });
        if (absent.counted) sessions.push({ date, kind: '결강', reason: absent.reason || '' });
      } else {
        sessions.push({ date, kind: '정규' });
      }
    }

    // 보충수업: 요일과 관계없이 회차 1회 추가
    for (const ev of events) {
      if (ev.type === '보충' && ev.date === date) {
        sessions.push({ date, kind: '보충', reason: ev.reason || '' });
        exceptions.push({ type: '보충', date, reason: ev.reason || '' });
      }
    }

    return { sessions, exceptions };
  }

  /**
   * 현재 회차(startDate 부터 cycle 회)를 계산한다.
   * - sessions: 회차로 인정되는 수업 목록 (회차 차감 결강 포함)
   * - exceptions: 휴강/결강/대체/보충 목록 (startDate ~ 다음 회차 시작 전날)
   * - lastDate: 마지막(N번째) 회차 날짜
   * - nextDate: 다음 회차 첫 수업일
   */
  function computeCycle(student, holidays, asOf) {
    const N = Number(student.cycle) || 0;
    const sessions = [];
    const exceptions = [];
    let nextDate = null;

    if (!student.startDate || !N || !(student.days || []).length) {
      return { sessions, exceptions, lastDate: null, nextDate: null, done: 0, total: N, error: '수업 시작일·요일·회차를 확인해 주세요.' };
    }

    let date = student.startDate;
    for (let i = 0; i < MAX_DAYS && !nextDate; i++, date = addDays(date, 1)) {
      const info = dayInfo(student, holidays, date);
      if (sessions.length >= N) {
        // 다음 회차 첫 수업일을 찾는 중
        if (info.sessions.length) {
          nextDate = date;
          break;
        }
        exceptions.push(...info.exceptions);
        continue;
      }
      exceptions.push(...info.exceptions);
      for (const s of info.sessions) {
        if (sessions.length < N) sessions.push({ ...s, no: sessions.length + 1 });
        else nextDate = date; // 같은 날 수업이 2개이고 그중 하나가 다음 회차
      }
    }

    const ref = asOf || today();
    const done = sessions.filter((s) => s.date <= ref).length;
    const lastDate = sessions.length === N ? sessions[N - 1].date : null;
    return { sessions, exceptions, lastDate, nextDate, done, total: N };
  }

  /** 결제일: settings.dueBasis 가 'last' 이면 마지막 회차일, 기본은 다음 회차 첫 수업일 */
  function dueDate(result, settings) {
    if (settings && settings.dueBasis === 'last') return result.lastDate;
    return result.nextDate;
  }

  function fmtException(ex) {
    const r = ex.reason ? `(${ex.reason})` : '';
    if (ex.type === '대체') return `${fmtMD(ex.date)}${r} → ${fmtMD(ex.toDate)}`;
    return `${fmtMD(ex.date)}${r}`;
  }

  function fillTemplate(text, vars) {
    return String(text || '').replace(/\{(\S+?)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }

  /** 결제 안내 메시지 */
  function buildMessage(student, result, settings) {
    settings = settings || {};
    const lines = [];
    lines.push(`${formatMinutes(student.minutes)} * ${cycleLabel(student.cycle)}`);
    lines.push(`수업 시작일: ${result.nextDate ? fmtDot(result.nextDate) : '-'}`); // 다음 회차 첫 수업일

    const groups = [
      ['휴강', (ex) => ex.type === '휴강'],
      ['결강', (ex) => ex.type === '결강' && !ex.counted],
      ['결강(회차차감)', (ex) => ex.type === '결강' && ex.counted],
      ['대체수업', (ex) => ex.type === '대체'],
      ['보충', (ex) => ex.type === '보충'],
    ];
    const body = [];
    for (const [label, match] of groups) {
      const list = result.exceptions.filter(match);
      if (list.length) body.push(`${label}: ${list.map(fmtException).join(', ')}`);
    }
    if (body.length) lines.push('--', ...body);

    const due = dueDate(result, settings);
    const vars = {
      이름: student.name || '',
      결제일: due ? fmtDot(due) : '',
      마지막회차: result.lastDate ? fmtDot(result.lastDate) : '',
      다음시작일: result.nextDate ? fmtDot(result.nextDate) : '',
    };
    const prefix = fillTemplate(settings.prefix, vars).trim();
    const suffix = fillTemplate(settings.suffix, vars).trim();
    return [prefix, lines.join('\n'), suffix].filter(Boolean).join('\n\n');
  }

  /** 결제 완료 처리: 다음 회차로 넘긴 새 student 객체를 돌려준다. */
  function advance(student, result, paidAt) {
    if (!result.nextDate) throw new Error('다음 회차 시작일을 계산할 수 없습니다.');
    return {
      ...student,
      startDate: result.nextDate,
      history: [
        ...(student.history || []),
        { start: student.startDate, last: result.lastDate, next: result.nextDate, paidAt: paidAt || today() },
      ],
    };
  }

  /**
   * 학생번호 입력값 정리: 숫자 1~2자리 → 두 자리 문자열 ('5' → '05'), 빈칸 → ''
   * 형식이 틀리면 null
   */
  function normalizeNo(input) {
    const v = String(input ?? '').trim();
    if (!v) return '';
    if (!/^\d{1,2}$/.test(v)) return null;
    return v.padStart(2, '0');
  }

  /**
   * 진도 카드 앱으로 보낼 명단 텍스트 (한 줄에 한 명: 번호<탭>이름<탭>학년)
   * 학생번호가 없는 학생은 빼고, 번호 순으로 정렬한다.
   */
  /** 등원 요일 [1, 3, 5] → '월수금' (월요일부터) */
  function daysText(days) {
    return [...new Set(days || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d] || '').join('');
  }

  function rosterText(students) {
    return students
      .filter((s) => s.no)
      .sort((a, b) => a.no.localeCompare(b.no))
      .map((s) => [s.no, s.name, s.grade || '', daysText(s.days)].join('\t'))
      .join('\n');
  }

  /** 직전 결제 완료 처리 취소 */
  function undoAdvance(student) {
    const history = [...(student.history || [])];
    const prev = history.pop();
    if (!prev) return student;
    return { ...student, startDate: prev.start, history };
  }

  /* ---------- 대기 학생 CSV 불러오기 (노션 데이터베이스 내보내기 등) ---------- */

  /** CSV 글자를 줄 × 칸 배열로 (따옴표 안의 쉼표·줄바꿈 처리) */
  function parseCsv(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  /** '2026/10/21', '2026년 10월 21일 오후 3:00', 'October 21, 2026' 등 → '2026-10-21' (못 읽으면 '') */
  function parseLooseDate(str) {
    const t = String(str || '').trim();
    const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31
      ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '');
    let m = t.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = t.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // 10/21/2026
    if (m) return ymd(+m[3], +m[1], +m[2]);
    return '';
  }

  /** '초등 5학년', '5학년', '중학교 1학년', '초5' → GRADES 이름 (못 읽으면 원래 글자) */
  function normalizeGrade(str) {
    const t = String(str || '').replace(/\s/g, '');
    if (!t) return '';
    if (GRADES.includes(t)) return t;
    const m = t.match(/^(초|중|고)\D*(\d)/) || t.match(/^(\d)학년$/);
    if (!m) return String(str).trim();
    const g = m.length === 3 ? m[1] + m[2] : '초' + m[1];
    return GRADES.includes(g) ? g : String(str).trim();
  }

  // 열 이름으로 어느 칸인지 판단 (위에서부터 먼저 맞는 것)
  const WAIT_COLUMNS = [
    ['time', /요일|시간|가능/],
    ['contact', /내용|상담|메모|비고|노트|기록|진행|note|memo/i],
    ['phone', /연락처|전화|휴대|핸드폰|번호|phone|tel|mobile/i],
    ['grade', /학년|grade/i],
    ['date', /날짜|일자|일시|대기일|문의일|등록일|date|created/i],
    ['name', /이름|성명|학생|name/i],
  ];

  /**
   * CSV → 대기 학생 목록. 알아보지 못한 열이나 같은 칸에 두 번째로 맞는 열은
   * '열 이름: 값' 으로 연락 내용 메모 끝에 붙여 빠지는 내용이 없게 한다.
   * 반환: { items: [{ date, grade, name, phone, time, contact }], columns: { 열 이름: 칸 | null } }
   */
  function waitlistFromCsv(text) {
    const [head, ...rows] = parseCsv(text);
    if (!head) return { items: [], columns: {} };
    const used = new Set();
    const fields = head.map((h) => {
      const hit = WAIT_COLUMNS.find(([, re]) => re.test(h.trim()));
      if (!hit) return null;
      if (used.has(hit[0]) && hit[0] !== 'contact' && hit[0] !== 'time') return null;
      used.add(hit[0]);
      return hit[0];
    });
    const items = rows.map((r) => {
      const w = { date: '', grade: '', name: '', phone: '', time: '', contact: '' };
      const extra = [];
      head.forEach((h, i) => {
        const v = String(r[i] ?? '').trim();
        if (!v) return;
        const f = fields[i];
        if (f === 'date') {
          w.date = parseLooseDate(v);
          if (!w.date) extra.push(`${h.trim()}: ${v}`); // 날짜로 못 읽으면 메모에 그대로
        } else if (f === 'grade') w.grade = normalizeGrade(v);
        else if (f === 'time' || f === 'contact') w[f] = w[f] ? `${w[f]}\n${v}` : v;
        else if (f === 'name' || f === 'phone') w[f] = v;
        else if (!f) extra.push(`${h.trim()}: ${v}`);
      });
      if (extra.length) w.contact = [w.contact, ...extra].filter(Boolean).join('\n');
      return w;
    });
    const columns = {};
    head.forEach((h, i) => (columns[h.trim()] = fields[i]));
    return { items: items.filter((w) => Object.values(w).some(Boolean)), columns };
  }

  return {
    WEEKDAYS,
    GRADES,
    addDays,
    weekday,
    today,
    diffDays,
    fmtMD,
    fmtDot,
    fmtMDW,
    formatMinutes,
    cycleLabel,
    parseFee,
    feeToInput,
    dayInfo,
    computeCycle,
    dueDate,
    buildMessage,
    advance,
    undoAdvance,
    normalizeNo,
    rosterText,
    daysText,
    parseCsv,
    parseLooseDate,
    normalizeGrade,
    waitlistFromCsv,
  };
});
