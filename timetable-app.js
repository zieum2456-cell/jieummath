/* 시간표 화면 / 저장 처리. 계산 로직은 timetable.js 참고 */
(function () {
  'use strict';
  const T = window.Timetable;
  const STORE_KEY = 'jieummath-timetable-v1';
  const PAYMENT_KEY = 'jieummath-payment-v1';
  const $ = (id) => document.getElementById(id);

  let state = load();
  let editingId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { students: Array.isArray(s.students) ? s.students : [] };
      }
    } catch (e) {
      console.error(e);
    }
    return { students: [] };
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
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');

  // 학생마다 고정 색 (이름이 아니라 id 기준이라 이름을 바꿔도 색이 유지됨)
  function hue(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return (h * 137.508) % 360;
  }

  /* ---------- 시간표 ---------- */
  function render() {
    renderTimetable();
    renderList();
  }

  function renderTimetable() {
    const rows = T.SLOTS.length;
    const lanes = T.assignLanes(state.students);
    $('timetable').innerHTML = T.DAYS.map(({ day, label }) => {
      const d = T.buildDay(state.students, day, lanes);
      const times = T.SLOTS.map((slot, i) => {
        const c = d.counts[i];
        return `<div class="${slot.end - slot.start === 60 ? 'hour' : ''}"><span>${T.fmtTime(slot.start)}</span><span class="cnt${c ? '' : ' zero'}">${c}명</span></div>`;
      }).join('');
      const grid = T.SLOTS.map((slot) => {
        const cls = ['grid'];
        if (slot.end % 60 === 0) cls.push('on-hour');
        if (slot.end - slot.start === 60) cls.push('hour');
        return `<div class="${cls.join(' ')}"></div>`;
      }).join('');
      const w = 100 / Math.max(d.lanes, 1);
      const bars = d.entries.map((e) => {
        const h = e.bottom - e.top;
        const title = `${e.name} ${T.fmtTime(e.in)}~${T.fmtTime(e.out)}`;
        return `<div class="bar" data-id="${esc(e.id)}" title="${esc(title)}" style="--h:${hue(e.id).toFixed(0)};`
          + `top:calc(var(--row) * ${e.top} + 1px);height:calc(var(--row) * ${h} - 2px);`
          + `left:calc(${w * e.lane}% + 1px);width:calc(${w}% - 2px)">`
          + `<b>${esc(e.name)}</b>${h >= 2 ? `<small>${T.fmtTime(e.in)}~${T.fmtTime(e.out)}</small>` : ''}</div>`;
      }).join('');
      return `<section class="day">
        <div class="day-head"><b>${label}요일</b><span>${d.entries.length}명</span></div>
        <div class="day-body">
          <div class="times">${times}</div>
          <div class="lanes" style="height:calc(var(--row) * ${rows})">${grid}${bars}${d.entries.length ? '' : '<div class="no-class">수업 없음</div>'}</div>
        </div>
      </section>`;
    }).join('');
  }

  $('timetable').addEventListener('click', (ev) => {
    const bar = ev.target.closest('.bar');
    if (!bar) return;
    startEdit(bar.dataset.id);
    $('form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---------- 학생 목록 ---------- */
  function timeText(s, day) {
    const t = s.times && s.times[day];
    if (!t || !t.in || !t.out) return '';
    return `${t.in}~${t.out}`;
  }

  function renderList() {
    const list = [...state.students].sort(byName);
    $('stu-count').textContent = `(${list.length}명)`;
    if (!list.length) {
      $('stu-table').innerHTML = '<tr><td class="empty">아직 등록된 학생이 없습니다. 위에서 학생을 추가해 주세요.</td></tr>';
      return;
    }
    $('stu-table').innerHTML = `<thead><tr><th>이름</th>${T.DAYS.map((d) => `<th>${d.label}</th>`).join('')}<th></th></tr></thead><tbody>`
      + list.map((s) => `<tr><td><b>${esc(s.name)}</b></td>${T.DAYS.map((d) => `<td class="t">${esc(timeText(s, d.day)) || '<span class="muted">-</span>'}</td>`).join('')}`
        + `<td><button class="btn small" data-edit="${esc(s.id)}">수정</button></td></tr>`).join('')
      + '</tbody>';
  }

  $('stu-table').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-edit]');
    if (!b) return;
    startEdit(b.dataset.edit);
    $('form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---------- 입력 폼 ---------- */
  const TIME_OPTIONS = (() => {
    const out = ['<option value="">--:--</option>'];
    for (let t = T.START; t <= T.END; t += 10) out.push(`<option>${T.fmtTime(t)}</option>`);
    return out.join('');
  })();

  $('f-days').innerHTML = T.DAYS.map(({ day, label }) => `<div class="day-row">
      <b>${label}</b>
      <select data-in="${day}" aria-label="${label}요일 등원">${TIME_OPTIONS}</select>
      <span>~</span>
      <select data-out="${day}" aria-label="${label}요일 하원">${TIME_OPTIONS}</select>
      <button class="btn small" type="button" data-clear="${day}">지우기</button>
    </div>`).join('');

  const inSel = (day) => document.querySelector(`[data-in="${day}"]`);
  const outSel = (day) => document.querySelector(`[data-out="${day}"]`);

  // 저장된 값이 10분 단위가 아니어도(백업 파일 직접 수정 등) 선택지에 보이도록 추가
  function setSelect(sel, value) {
    if (value && ![...sel.options].some((o) => o.value === value)) sel.add(new Option(value, value));
    sel.value = value || '';
  }

  $('f-days').addEventListener('change', (ev) => {
    const day = ev.target.dataset.in;
    if (!day) return;
    const a = T.parseTime(ev.target.value);
    const out = outSel(day);
    const b = T.parseTime(out.value);
    if (a != null && (b == null || b <= a)) {
      setSelect(out, T.fmtTime(Math.min(a + Number($('f-length').value), T.END)));
    }
  });

  $('f-days').addEventListener('click', (ev) => {
    const day = ev.target.dataset.clear;
    if (!day) return;
    inSel(day).value = '';
    outSel(day).value = '';
  });

  function resetForm() {
    editingId = null;
    $('f-name').value = '';
    T.DAYS.forEach(({ day }) => { inSel(day).value = ''; outSel(day).value = ''; });
    $('f-err').textContent = '';
    $('form-title').textContent = '학생 추가';
    $('f-save').textContent = '추가';
    $('f-cancel').classList.add('hidden');
    $('f-delete').classList.add('hidden');
  }

  function startEdit(id) {
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    editingId = id;
    $('f-name').value = s.name;
    T.DAYS.forEach(({ day }) => {
      const t = (s.times && s.times[day]) || {};
      setSelect(inSel(day), t.in);
      setSelect(outSel(day), t.out);
    });
    $('f-err').textContent = '';
    $('form-title').textContent = `학생 수정 · ${s.name}`;
    $('f-save').textContent = '저장';
    $('f-cancel').classList.remove('hidden');
    $('f-delete').classList.remove('hidden');
  }

  $('f-save').addEventListener('click', () => {
    const name = $('f-name').value.trim();
    if (!name) {
      $('f-err').textContent = '이름을 입력해 주세요.';
      $('f-name').focus();
      return;
    }
    const times = {};
    for (const { day, label } of T.DAYS) {
      const t = { in: inSel(day).value, out: outSel(day).value };
      const err = T.validateTime(t);
      if (err) {
        $('f-err').textContent = `${label}요일: ${err}`;
        return;
      }
      if (t.in && t.out) times[day] = t;
    }
    if (editingId) {
      const s = state.students.find((x) => x.id === editingId);
      s.name = name;
      s.times = times;
    } else {
      if (state.students.some((s) => s.name === name) && !confirm(`이미 '${name}' 학생이 있습니다. 그래도 추가할까요?`)) return;
      state.students.push({ id: uid(), name, times });
    }
    save();
    resetForm();
    render();
  });

  $('f-cancel').addEventListener('click', resetForm);

  $('f-delete').addEventListener('click', () => {
    const s = state.students.find((x) => x.id === editingId);
    if (!s || !confirm(`'${s.name}' 학생을 시간표에서 삭제할까요?`)) return;
    state.students = state.students.filter((x) => x.id !== editingId);
    save();
    resetForm();
    render();
  });

  /* ---------- 불러오기 / 백업 ---------- */
  $('btn-import').addEventListener('click', () => {
    let names = [];
    try {
      const raw = localStorage.getItem(PAYMENT_KEY);
      names = raw ? (JSON.parse(raw).students || []).map((s) => String(s.name || '').trim()).filter(Boolean) : [];
    } catch (e) {
      console.error(e);
    }
    if (!names.length) {
      alert('결제일 관리에 등록된 학생이 없습니다.\n(같은 브라우저에서 결제일 관리를 사용 중이어야 불러올 수 있습니다.)');
      return;
    }
    const have = new Set(state.students.map((s) => s.name));
    const add = [...new Set(names)].filter((n) => !have.has(n));
    if (!add.length) {
      alert('결제일 관리의 학생이 모두 이미 등록되어 있습니다.');
      return;
    }
    add.forEach((name) => state.students.push({ id: uid(), name, times: {} }));
    save();
    render();
    alert(`${add.length}명을 불러왔습니다: ${add.join(', ')}\n학생 목록에서 '수정'을 눌러 요일별 등원·하원 시각을 입력해 주세요.`);
  });

  $('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `시간표-백업-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btn-restore').addEventListener('click', () => $('restore-file').click());
  $('restore-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.students) || data.holidays) throw new Error('시간표 백업 파일이 아닙니다.');
      if (!confirm(`백업의 학생 ${data.students.length}명으로 지금 시간표를 바꿀까요?`)) return;
      state = { students: data.students };
      save();
      resetForm();
      render();
    } catch (e) {
      alert('불러오기에 실패했습니다.\n' + e.message);
    }
  });

  $('btn-print').addEventListener('click', () => window.print());

  render();
})();
