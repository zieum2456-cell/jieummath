/*
 * 결제일 계산 / 안내 메시지 생성 로직
 * 브라우저(window.Payment)와 Node(require) 양쪽에서 사용할 수 있다.
 *
 * 날짜는 모두 'YYYY-MM-DD' 문자열로 다룬다.
 *
 * student = {
 *   id, name,
 *   minutes: 120,            // 회당 수업시간(분)
 *   cycle: 12 | 8,           // 결제 기준 회차
 *   days: [1, 3, 5],         // 등원 요일 (0=일 ... 6=토)
 *   startDate: '2026-10-01', // 이번 회차 수업 시작일
 *   events: [
 *     { id, type: '휴강', date, reason },
 *     { id, type: '결강', date, reason, counted: false }, // counted=true 면 회차 차감(이월 안 함)
 *     { id, type: '대체', date, toDate, reason },          // date 수업을 toDate 로 옮김
 *   ],
 *   history: [{ start, last, next, paidAt }],
 * }
 * holidays = [{ id, date, reason }]  // 전체 휴강(공휴일, 방학 등) - 모든 학생에게 적용
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Payment = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
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
    min = Number(min) || 0;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h && m) return `${h}시간 ${m}분`;
    if (h) return `${h}시간`;
    return `${m}분`;
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
      const holiday = (holidays || []).find((h) => h.date === date);
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

    return { sessions, exceptions };
  }

  /**
   * 현재 회차(startDate 부터 cycle 회)를 계산한다.
   * - sessions: 회차로 인정되는 수업 목록 (회차 차감 결강 포함)
   * - exceptions: 휴강/결강/대체 목록 (startDate ~ 다음 회차 시작 전날)
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
    const reasons = [];
    if (ex.reason) reasons.push(ex.reason);
    if (ex.type === '결강' && ex.counted) reasons.push('회차 차감');
    const r = reasons.length ? `(${reasons.join(', ')})` : '';
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
    lines.push(`${formatMinutes(student.minutes)} * ${student.cycle}회`);
    lines.push(`수업 시작일: ${fmtDot(student.startDate)}`);

    const groups = [
      ['휴강', '휴강'],
      ['결강', '결강'],
      ['대체', '대체수업'],
    ];
    const body = [];
    for (const [type, label] of groups) {
      const list = result.exceptions.filter((ex) => ex.type === type);
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

  /** 직전 결제 완료 처리 취소 */
  function undoAdvance(student) {
    const history = [...(student.history || [])];
    const prev = history.pop();
    if (!prev) return student;
    return { ...student, startDate: prev.start, history };
  }

  return {
    WEEKDAYS,
    addDays,
    weekday,
    today,
    diffDays,
    fmtMD,
    fmtDot,
    fmtMDW,
    formatMinutes,
    cycleLabel,
    dayInfo,
    computeCycle,
    dueDate,
    buildMessage,
    advance,
    undoAdvance,
  };
});
