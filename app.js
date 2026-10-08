/* 화면 / 저장 처리. 계산 로직은 payment.js 참고 */
(function () {
  'use strict';
  const P = window.Payment;
  const STORE_KEY = 'jieummath-payment-v1';
  const $ = (id) => document.getElementById(id);

  const DEFAULT_STATE = {
    students: [],
    holidays: [],
    settings: { dueBasis: 'next', soonDays: 3, prefix: '', suffix: '' },
  };

  let state = load();
  let currentId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...s, settings: { ...DEFAULT_STATE.settings, ...(s.settings || {}) } };
      }
    } catch (e) {
      console.error(e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      alert('저장에 실패했습니다. 백업 파일을 받아 두세요.\n' + e.message);
    }
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const daysText = (days) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => P.WEEKDAYS[d]).join('·');
  const findStudent = (id) => state.students.find((s) => s.id === id);
  const calc = (s) => P.computeCycle(s, state.holidays);

  /* ---------- 탭 ---------- */
  const TABS = ['dashboard', 'students', 'holidays', 'settings', 'detail'];
  function show(tab) {
    TABS.forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== tab));
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'dashboard') renderDashboard();
    if (tab === 'students') renderStudents();
    if (tab === 'holidays') renderHolidays();
    if (tab === 'settings') renderSettings();
    if (tab === 'detail') renderDetail();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  /* ---------- 결제 현황 ---------- */
  function dueBadge(due) {
    if (!due) return '<span class="badge over">계산 불가</span>';
    const d = P.diffDays(P.today(), due);
    if (d < 0) return `<span class="badge over">D+${-d} 지남</span>`;
    if (d === 0) return '<span class="badge over">오늘</span>';
    if (d <= Number(state.settings.soonDays)) return `<span class="badge soon">D-${d}</span>`;
    return `<span class="badge">D-${d}</span>`;
  }

  function renderDashboard() {
    $('today-label').textContent = '오늘 ' + P.fmtDot(P.today());
    const rows = state.students.map((s) => {
      const r = calc(s);
      return { s, r, due: P.dueDate(r, state.settings) };
    });
    rows.sort((a, b) => (a.due || '0000').localeCompare(b.due || '0000'));
    $('dash-body').innerHTML = rows.length
      ? rows
          .map(
            ({ s, r, due }) => `<tr class="click" data-id="${s.id}">
        <td><b>${esc(s.name)}</b></td>
        <td>${daysText(s.days)} · ${P.formatMinutes(s.minutes)} · ${P.cycleLabel(s.cycle)}</td>
        <td>${r.done} / ${r.total}</td>
        <td>${r.lastDate ? P.fmtMDW(r.lastDate) : '-'}</td>
        <td>${due ? P.fmtMDW(due) : '-'}</td>
        <td>${dueBadge(due)}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="empty">학생 관리 탭에서 학생을 추가해 주세요.</td></tr>';
    $('dash-body').querySelectorAll('tr.click').forEach((tr) =>
      tr.addEventListener('click', () => {
        currentId = tr.dataset.id;
        show('detail');
      })
    );
  }

  /* ---------- 학생 상세 ---------- */
  function sessionNote(x) {
    if (x.kind === '결강') return `<span class="kind-결강">결강 · 회차 차감${x.reason ? ' (' + esc(x.reason) + ')' : ''}</span>`;
    if (x.kind === '대체') return `<span class="kind-대체">대체수업 ← ${P.fmtMD(x.from)}</span>`;
    if (x.kind === '보충') return `<span class="kind-대체">보충수업${x.reason ? ' (' + esc(x.reason) + ')' : ''}</span>`;
    return '';
  }

  function exceptionNote(ex) {
    const r = ex.reason ? ` (${esc(ex.reason)})` : '';
    if (ex.type === '휴강') return `휴강${r}`;
    if (ex.type === '결강') return `<span class="kind-결강">결강 · 회차 이월${r}</span>`;
    return `<span class="kind-대체">→ ${P.fmtMD(ex.toDate)} 대체${r}</span>`;
  }

  function renderDetail() {
    const s = findStudent(currentId);
    if (!s) return show('dashboard');
    const r = calc(s);
    const due = P.dueDate(r, state.settings);
    const today = P.today();

    $('d-title').innerHTML = `${esc(s.name)} ${dueBadge(due)}`;
    $('d-summary').innerHTML = [
      `${daysText(s.days)} · ${P.formatMinutes(s.minutes)} · ${P.cycleLabel(s.cycle)} 결제`,
      `수업 시작일 ${P.fmtDot(s.startDate)}`,
      `진행 ${r.done}/${r.total}회`,
      `마지막 회차 ${r.lastDate ? P.fmtMDW(r.lastDate) : '-'}`,
      `다음 회차 시작 ${r.nextDate ? P.fmtMDW(r.nextDate) : '-'}`,
      s.memo ? `메모: ${esc(s.memo)}` : '',
    ]
      .filter(Boolean)
      .join(' &nbsp;|&nbsp; ');

    // 수업 일정 (회차 + 예외를 날짜순으로)
    const rows = [
      ...r.sessions.map((x) => ({ date: x.date, no: x.no, note: sessionNote(x) })),
      ...r.exceptions.filter((ex) => !(ex.type === '결강' && ex.counted) && ex.type !== '보충').map((ex) => ({ date: ex.date, no: '-', note: exceptionNote(ex) })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.no === '-' ? -1 : 1));
    if (r.nextDate) rows.push({ date: r.nextDate, no: '다음', note: '<b>다음 회차 시작</b>' });
    $('sess').innerHTML = rows
      .map((x) => `<tr class="${x.date > today ? 'future' : ''}"><td>${x.no}</td><td>${P.fmtMDW(x.date)}</td><td>${x.note}</td></tr>`)
      .join('');

    // 등록 내역
    const evs = (s.events || [])
      .filter((ev) => ev.date >= s.startDate || (ev.toDate && ev.toDate >= s.startDate))
      .sort((a, b) => a.date.localeCompare(b.date));
    $('ev-list').innerHTML = evs.length
      ? evs
          .map((ev) => {
            let label = ev.type;
            if (ev.type === '결강') label += ev.counted ? ' (차감)' : ' (이월)';
            const when = ev.type === '대체' ? `${P.fmtMDW(ev.date)} → ${P.fmtMDW(ev.toDate)}` : P.fmtMDW(ev.date);
            return `<tr><td>${label}</td><td>${when}</td><td>${esc(ev.reason)}</td>
              <td style="text-align:right"><button class="btn small danger" data-del="${ev.id}">삭제</button></td></tr>`;
          })
          .join('')
      : '<tr><td class="muted">없음</td></tr>';
    $('ev-list').querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        s.events = s.events.filter((ev) => ev.id !== b.dataset.del);
        save();
        renderDetail();
      })
    );

    // 메시지
    $('msg').value = P.buildMessage(s, r, state.settings);
    $('copy-state').textContent = '';

    // 결제
    $('paid-at').value = today;
    $('hist').innerHTML = (s.history || []).length
      ? [...s.history]
          .reverse()
          .map((h) => `<tr><td>${P.fmtDot(h.start)} ~ ${h.last ? P.fmtDot(h.last) : '-'}</td><td class="muted">결제 ${P.fmtDot(h.paidAt)}</td></tr>`)
          .join('')
      : '<tr><td class="muted">없음</td></tr>';
    $('undo').disabled = !(s.history || []).length;
  }

  function updateEventForm() {
    const t = $('ev-type').value;
    $('ev-to-wrap').classList.toggle('hidden', t !== '대체');
    $('ev-date-label').textContent = t === '대체' ? '원래 수업일' : '날짜';
    $('ev-help').textContent = {
      휴강: '학원 사정으로 쉬는 날. 회차로 세지 않고 결제일이 미뤄집니다.',
      '결강-이월': '학생이 빠졌지만 회차를 이월해 주는 결강. 결제일이 미뤄집니다.',
      '결강-차감': '학생이 빠졌지만 회차로 인정(차감)하는 결강. 결제일이 미뤄지지 않습니다.',
      대체: '원래 수업일 대신 다른 날 수업. 대체한 날이 회차로 계산됩니다.',
      보충: '정규 수업 외에 추가로 진행한 수업. 회차 1회가 추가되어 결제일이 앞당겨집니다.',
    }[t];
  }
  $('ev-type').addEventListener('change', updateEventForm);

  $('ev-add').addEventListener('click', () => {
    const s = findStudent(currentId);
    const t = $('ev-type').value;
    const date = $('ev-date').value;
    const toDate = $('ev-to').value;
    const reason = $('ev-reason').value.trim();
    if (!date) return alert('날짜를 입력해 주세요.');
    if (t === '대체' && !toDate) return alert('대체 날짜를 입력해 주세요.');
    if (t !== '보충' && !s.days.includes(P.weekday(date)) && !confirm(`${P.fmtMDW(date)}은(는) ${s.name} 학생의 등원 요일이 아닙니다. 그래도 등록할까요?\n(등원 요일이 아니면 계산에 반영되지 않습니다.)`)) return;
    const type = t.startsWith('결강') ? '결강' : t;
    const single = (x) => x !== '대체' && x !== '보충';
    if (single(type) && s.events.some((ev) => single(ev.type) && ev.date === date) &&
        !confirm('같은 날짜에 이미 등록된 내역이 있습니다. 추가할까요?')) return;
    const ev = { id: uid(), type, date, reason };
    if (type === '결강') ev.counted = t === '결강-차감';
    if (type === '대체') ev.toDate = toDate;
    s.events.push(ev);
    save();
    $('ev-reason').value = '';
    $('ev-to').value = '';
    renderDetail();
  });

  $('copy').addEventListener('click', async () => {
    const text = $('msg').value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      $('msg').select();
      document.execCommand('copy');
    }
    $('copy-state').textContent = '복사했습니다.';
  });
  $('regen').addEventListener('click', renderDetail);

  $('advance').addEventListener('click', () => {
    const s = findStudent(currentId);
    const r = calc(s);
    if (!r.nextDate) return alert('다음 회차 시작일을 계산할 수 없습니다.');
    if (!confirm(`결제 완료로 처리하고 다음 회차를 ${P.fmtMDW(r.nextDate)}부터 시작할까요?`)) return;
    Object.assign(s, P.advance(s, r, $('paid-at').value || P.today()));
    save();
    renderDetail();
  });

  $('undo').addEventListener('click', () => {
    const s = findStudent(currentId);
    if (!confirm('직전 결제 완료 처리를 취소하고 이전 회차로 되돌릴까요?')) return;
    Object.assign(s, P.undoAdvance(s));
    save();
    renderDetail();
  });

  $('back').addEventListener('click', () => show('dashboard'));
  $('edit-student').addEventListener('click', () => {
    show('students');
    fillForm(findStudent(currentId));
  });

  /* ---------- 학생 관리 ---------- */
  $('f-days').innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `<label><input type="checkbox" value="${d}">${P.WEEKDAYS[d]}</label>`)
    .join('');

  function fillForm(s) {
    $('form-title').textContent = s ? `학생 수정: ${s.name}` : '학생 추가';
    $('f-id').value = s ? s.id : '';
    $('f-name').value = s ? s.name : '';
    $('f-min').value = s ? s.minutes : 120;
    $('f-cycle').value = s ? String(s.cycle) : '12';
    $('f-start').value = s ? s.startDate : P.today();
    $('f-memo').value = s ? s.memo || '' : '';
    $('f-days').querySelectorAll('input').forEach((c) => (c.checked = s ? s.days.includes(Number(c.value)) : false));
  }

  $('student-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const days = [...$('f-days').querySelectorAll('input:checked')].map((c) => Number(c.value));
    if (!days.length) return alert('등원 요일을 하나 이상 선택해 주세요.');
    const data = {
      name: $('f-name').value.trim(),
      minutes: Number($('f-min').value),
      cycle: Number($('f-cycle').value),
      days,
      startDate: $('f-start').value,
      memo: $('f-memo').value.trim(),
    };
    const id = $('f-id').value;
    if (id) Object.assign(findStudent(id), data);
    else state.students.push({ id: uid(), events: [], history: [], ...data });
    save();
    fillForm(null);
    renderStudents();
  });
  $('f-cancel').addEventListener('click', () => fillForm(null));

  function renderStudents() {
    $('stu-body').innerHTML = state.students.length
      ? state.students
          .map(
            (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${daysText(s.days)}</td><td>${P.formatMinutes(s.minutes)}</td>
        <td>${P.cycleLabel(s.cycle)}</td><td>${P.fmtDot(s.startDate)}</td><td class="muted">${esc(s.memo)}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn small" data-open="${s.id}">보기</button>
          <button class="btn small" data-edit="${s.id}">수정</button>
          <button class="btn small danger" data-remove="${s.id}">삭제</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="empty">등록된 학생이 없습니다.</td></tr>';
    const on = (attr, fn) => $('stu-body').querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.dataset[attr])));
    on('open', (id) => {
      currentId = id;
      show('detail');
    });
    on('edit', (id) => {
      fillForm(findStudent(id));
      window.scrollTo(0, 0);
    });
    on('remove', (id) => {
      const s = findStudent(id);
      if (!confirm(`${s.name} 학생을 삭제할까요? 등록된 휴강·결강 내역도 함께 삭제됩니다.`)) return;
      state.students = state.students.filter((x) => x.id !== id);
      save();
      renderStudents();
    });
  }

  /* ---------- 전체 휴강 ---------- */
  $('h-add').addEventListener('click', () => {
    const start = $('h-date').value;
    const end = $('h-end').value || start;
    const reason = $('h-reason').value.trim();
    if (!start) return alert('날짜를 입력해 주세요.');
    if (end < start) return alert('종료일이 시작일보다 빠릅니다.');
    for (let d = start; d <= end; d = P.addDays(d, 1)) {
      if (!state.holidays.some((h) => h.date === d)) state.holidays.push({ id: uid(), date: d, reason });
    }
    state.holidays.sort((a, b) => a.date.localeCompare(b.date));
    save();
    $('h-date').value = $('h-end').value = $('h-reason').value = '';
    renderHolidays();
  });

  function renderHolidays() {
    $('h-list').innerHTML = state.holidays.length
      ? state.holidays
          .map((h) => `<tr><td>${P.fmtDot(h.date)} (${P.WEEKDAYS[P.weekday(h.date)]})</td><td>${esc(h.reason)}</td>
            <td style="text-align:right"><button class="btn small danger" data-del="${h.id}">삭제</button></td></tr>`)
          .join('')
      : '<tr><td class="muted">없음</td></tr>';
    $('h-list').querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        state.holidays = state.holidays.filter((h) => h.id !== b.dataset.del);
        save();
        renderHolidays();
      })
    );
  }

  /* ---------- 설정 ---------- */
  function renderSettings() {
    document.querySelectorAll('input[name="due"]').forEach((r) => (r.checked = r.value === state.settings.dueBasis));
    $('s-soon').value = state.settings.soonDays;
    $('s-prefix').value = state.settings.prefix;
    $('s-suffix').value = state.settings.suffix;
    $('s-state').textContent = '';
  }
  $('s-save').addEventListener('click', () => {
    const due = document.querySelector('input[name="due"]:checked');
    state.settings = {
      dueBasis: due ? due.value : 'next',
      soonDays: Number($('s-soon').value) || 0,
      prefix: $('s-prefix').value,
      suffix: $('s-suffix').value,
    };
    save();
    $('s-state').textContent = '저장했습니다.';
  });
  document.querySelectorAll('input[name="due"]').forEach((r) => r.addEventListener('change', () => $('s-save').click()));

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `결제관리-백업-${P.today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.students)) throw new Error('형식이 올바르지 않습니다.');
      if (!confirm(`학생 ${data.students.length}명의 데이터로 현재 데이터를 덮어쓸까요?`)) return;
      state = { ...DEFAULT_STATE, ...data, settings: { ...DEFAULT_STATE.settings, ...(data.settings || {}) } };
      save();
      alert('불러왔습니다.');
      show('dashboard');
    } catch (err) {
      alert('불러오기 실패: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  updateEventForm();
  fillForm(null);
  show('dashboard');
})();
