// 판독 확인 화면
const FIELD_TITLES = {
  card: "카드", handwriting: "손글씨 판독", lesson_date: "수업일자", student_number: "학생 번호", name: "이름",
  attendance: "출결", arrive_time: "등원", leave_time: "하원", last_hw: "지난 과제", stages: "단계",
  goal_items: "학습 목표", progress: "진행률", error_causes: "오답 원인", attitude: "학습태도",
  bonus_range: "추가 포인트 범위", bonus_points: "추가 포인트", today_hw: "오늘 과제",
};
// 손글씨에서 오는 값 (판독이 끝나면 아직 손대지 않은 칸만 새 값으로 바꾼다)
const HANDWRITING_KEYS = ["name", "arrive_time", "leave_time", "goal_items", "attitude", "bonus_range", "today_hw", "memo"];

const state = { status: "pending", cards: [], current: null, values: null, touched: new Set(), checkFlags: {}, students: [], poll: null };
const $content = document.querySelector("#content");

function params() { return new URLSearchParams(location.search); }

async function loadList() {
  state.cards = await api(`/api/cards?status=${state.status}`);
  renderStrip();
  refreshPendingBadge();
}

function renderStrip() {
  const strip = document.querySelector("#strip");
  strip.replaceChildren(...state.cards.map((c) => {
    const who = c.student_number !== null && c.student_number !== undefined
      ? `${c.student_number} ${c.student_name || c.name || "?"}` : `카드 ${c.id}`;
    return el("button", { class: "chip" + (state.current && state.current.id === c.id ? " on" : ""), onclick: () => openCard(c.id) },
      who, el("span", { class: "badge" }, c.flag_count || ""));
  }));
  if (!state.cards.length) {
    $content.replaceChildren(el("div", { class: "empty" },
      state.status === "pending" ? "확인할 카드가 없습니다. " : "카드가 없습니다. ",
      el("a", { href: "/" }, "카드 촬영하기")));
  }
}

async function openCard(id) {
  clearTimeout(state.poll);
  const card = await api(`/api/cards/${id}`);
  state.current = card;
  state.values = structuredClone(card.values);
  state.touched = new Set();
  state.checkFlags = card.check_flags;
  history.replaceState(null, "", `/review?card=${id}&status=${state.status}`);
  renderStrip();
  render();
  schedulePoll();
}

function schedulePoll() {
  const c = state.current;
  if (!c || !["waiting", "reading"].includes(c.ai_status)) return;
  state.poll = setTimeout(async () => {
    try {
      const fresh = await api(`/api/cards/${c.id}`);
      if (!state.current || state.current.id !== c.id) return;
      for (const k of HANDWRITING_KEYS) if (!state.touched.has(k)) state.values[k] = fresh.values[k];
      state.current = { ...fresh, values: state.current.values };
      state.checkFlags = fresh.check_flags;
      render();
      if (fresh.ai_status === "done") toast("손글씨 판독이 끝났습니다");
    } catch (e) { /* 다음에 다시 */ }
    schedulePoll();
  }, 3000);
}

// ---------- 확인 필요 계산 ----------
function readFlags() { return state.current.read_flags || {}; }

function openFlags() {
  // 손대지 않은 판독 단계 사유 + 현재 값 기준 모순
  const out = {};
  for (const [k, msgs] of Object.entries(readFlags())) if (!state.touched.has(k)) out[k] = [...msgs];
  for (const [k, msgs] of Object.entries(state.checkFlags || {})) (out[k] = out[k] || []).push(...msgs);
  return out;
}

let checkTimer = null;
function touched(key) {
  state.touched.add(key);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/cards/${state.current.id}/check`, { json: { values: state.values } });
      state.checkFlags = r.check_flags;
      updateFlagMarks();
    } catch (e) { /* 무시 */ }
  }, 400);
  updateFlagMarks();
}

function updateFlagMarks() {
  const open = openFlags();
  document.querySelectorAll(".field[data-key]").forEach((node) => {
    const keys = node.dataset.key.split(",");
    const read = keys.flatMap((k) => (readFlags()[k] || []).map((m) => ({ m, done: state.touched.has(k) })));
    const checks = keys.flatMap((k) => (state.checkFlags[k] || []).map((m) => ({ m, done: false })));
    const all = [...read, ...checks];
    node.classList.toggle("need", keys.some((k) => open[k]));
    let ul = node.querySelector(":scope > .reasons");
    if (!all.length) { if (ul) ul.remove(); return; }
    if (!ul) { ul = el("ul", { class: "reasons" }); node.append(ul); }
    ul.replaceChildren(...all.map((r) => el("li", { class: r.done ? "done" : "" }, r.m)));
  });
  renderSummary();
}

function renderSummary() {
  const box = document.querySelector("#flag-summary");
  if (!box) return;
  const open = openFlags();
  const order = Object.keys(FIELD_TITLES);
  const keys = Object.keys(open).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!keys.length) {
    box.className = "flag-summary none";
    box.textContent = "확인 필요 항목이 없습니다. 내용을 훑어보고 저장하세요.";
    return;
  }
  box.className = "flag-summary has";
  box.replaceChildren(`확인 필요 ${keys.length}곳: `,
    ...keys.flatMap((k, i) => [i ? ", " : "", el("a", { href: `#f-${k}`, onclick: (e) => { e.preventDefault(); jump(k); } }, FIELD_TITLES[k] || k)]));
}

function jump(key) {
  const node = document.querySelector(`#f-${key}`) || document.querySelector(`[data-key*="${key}"]`);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- 입력 부품 ----------
function field(key, title, ...body) {
  return el("div", { class: "field", id: `f-${key.split(",")[0]}`, "data-key": key }, el("div", { class: "label" }, title), ...body);
}

function crop(region) {
  if (!state.current.has_image) return null;
  return el("img", { class: "crop", src: `/api/cards/${state.current.id}/crop/${region}`, alt: `${region} 손글씨`, loading: "lazy" });
}

function textInput(key, placeholder = "") {
  return el("input", { type: "text", value: state.values[key] ?? "", placeholder,
    oninput: (e) => { state.values[key] = e.target.value; touched(key); } });
}

function seg(key, options, { multi = false, numeric = false } = {}) {
  const wrap = el("div", { class: "seg" });
  const draw = () => wrap.replaceChildren(...Object.entries(options).map(([v, label]) => {
    const val = numeric ? Number(v) : v;
    const cur = state.values[key];
    const on = multi ? (cur || []).includes(val) : cur === val;
    return el("button", { type: "button", class: on ? "on" : "", onclick: () => {
      if (multi) {
        const set = new Set(state.values[key] || []);
        set.has(val) ? set.delete(val) : set.add(val);
        state.values[key] = [...set];
      } else {
        state.values[key] = cur === val && key === "bonus_points" ? null : val;
      }
      touched(key);
      draw();
    } }, label);
  }));
  draw();
  return wrap;
}

function goalEditor() {
  const wrap = el("div", { class: "goals" });
  const draw = () => {
    const items = state.values.goal_items || [];
    wrap.replaceChildren(...items.map((g, i) => {
      const set = (k, v) => { g[k] = v; touched("goal_items"); };
      const color = el("select", { class: `g-color c-${g.color}`, onchange: (e) => { set("color", e.target.value); color.className = `g-color c-${g.color}`; } },
        Object.entries(LABELS.color).map(([v, l]) => el("option", { value: v, selected: g.color === v }, l)));
      const num = (k, ph) => el("input", { type: "number", inputmode: "numeric", value: g[k] ?? "", placeholder: ph,
        oninput: (e) => set(k, e.target.value === "" ? null : Number(e.target.value)) });
      return el("div", { class: "goal" },
        color,
        el("input", { class: "g-book", type: "text", value: g.book ?? "", placeholder: "교재", oninput: (e) => set("book", e.target.value) }),
        el("input", { class: "g-unit", type: "text", value: g.unit ?? "", placeholder: "단원", oninput: (e) => set("unit", e.target.value) }),
        el("div", { class: "g-pages" }, num("page_from", "쪽"), "~", num("page_to", "쪽")),
        el("select", { class: "g-mark", onchange: (e) => set("mark", e.target.value) },
          Object.entries(LABELS.mark).map(([v, l]) => el("option", { value: v, selected: g.mark === v }, v === "none" ? "–" : l.split(" ")[0]))),
        el("input", { class: "g-raw", type: "text", value: g.raw_text ?? "", placeholder: "적힌 그대로", oninput: (e) => set("raw_text", e.target.value) }),
        el("button", { type: "button", class: "btn danger g-del", title: "삭제", onclick: () => { items.splice(i, 1); touched("goal_items"); draw(); } }, "✕"));
    }), el("button", { type: "button", class: "btn", onclick: () => {
      const items2 = state.values.goal_items = state.values.goal_items || [];
      items2.push({ line: (items2.at(-1)?.line || 1), color: "blue", book: "", unit: null, page_from: null, page_to: null, mark: "none", raw_text: "" });
      touched("goal_items");
      draw();
    } }, "+ 범위 추가"));
  };
  draw();
  return wrap;
}

function studentInfo() {
  const n = state.values.student_number;
  const s = state.students.find((x) => x.number === Number(n));
  return s ? `명단: ${s.name}${s.grade ? ` (${s.grade})` : ""}` : (n === null || n === "" ? "" : "명단에 없음");
}

// ---------- 화면 그리기 ----------
function render() {
  const c = state.current;
  const v = state.values;
  const aiMsg = { waiting: "손글씨 판독 대기 중…", reading: "손글씨 판독 중…", error: `손글씨 판독 실패: ${c.ai_error || ""}`, off: "손글씨 판독 꺼짐 (API 키 없음)", done: "" }[c.ai_status];

  const image = c.has_image
    ? el("img", { src: `/api/cards/${c.id}/image`, alt: "카드 이미지", onclick: () => openZoom(`/api/cards/${c.id}/image`) })
    : el("div", { class: "empty" }, "보관 기간이 지나 카드 이미지가 삭제되었습니다.");
  const cardView = el("div", { class: "card-view" },
    el("details", { open: window.matchMedia("(min-width: 900px)").matches }, el("summary", {}, "카드 전체 이미지 보기"), image),
    el("p", { class: "muted small" }, `사진 #${c.photo_id}의 ${c.card_index + 1}번째 카드 · 업로드 ${c.uploaded_at || ""}`));

  const studentLine = el("div", { class: "muted small", id: "student-info" }, studentInfo());
  const form = el("div", { class: "panel" },
    el("div", { id: "flag-summary" }),
    aiMsg ? el("div", { class: "notice", style: "margin-bottom:8px" }, aiMsg) : null,
    (readFlags().card || readFlags().handwriting || c.status === "saved")
      ? field("card,handwriting", "판독 상태", el("div", { class: "muted small" }, c.status === "saved" ? "저장된 카드입니다. 고친 뒤 다시 저장하면 기록이 바뀝니다." : "아래 사유를 확인하세요"))
      : null,
    field("lesson_date", "수업일자 (기본: 촬영일)",
      el("input", { type: "date", value: v.lesson_date || "", onchange: (e) => { v.lesson_date = e.target.value; touched("lesson_date"); } })),
    field("student_number", "학생 번호",
      el("input", { type: "number", inputmode: "numeric", min: 0, max: 99, value: v.student_number ?? "",
        oninput: (e) => { v.student_number = e.target.value === "" ? null : Number(e.target.value); studentLine.textContent = studentInfo(); touched("student_number"); } }),
      studentLine),
    field("name", "이름 (손글씨, 참고용)", crop("name"), textInput("name")),
    field("attendance", "출결", seg("attendance", LABELS.attendance)),
    field("arrive_time,leave_time", "등원 · 하원", crop("times"),
      el("div", { class: "inline" },
        el("label", {}, "등원", el("input", { type: "time", value: v.arrive_time || "", onchange: (e) => { v.arrive_time = e.target.value || null; touched("arrive_time"); } })),
        el("label", {}, "하원", el("input", { type: "time", value: v.leave_time || "", onchange: (e) => { v.leave_time = e.target.value || null; touched("leave_time"); } })))),
    field("last_hw", "지난 과제", seg("last_hw", LABELS.last_hw)),
    field("stages", "단계 (여러 개 가능)", seg("stages", LABELS.stages, { multi: true })),
    field("goal_items", "학습 목표", crop("goals"),
      el("div", { class: "muted small", style: "margin-bottom:6px" }, "초록=지난 과제 · 파랑=오늘 진도 · 빨강=추가 포인트 · 검정=오늘 과제 / ○ 끝냄 · △ 덜함"),
      goalEditor()),
    field("progress", "진행률", seg("progress", LABELS.progress)),
    field("error_causes", "오답 원인 (여러 개 가능)", seg("error_causes", LABELS.error_causes, { multi: true })),
    field("attitude", "학습태도", crop("attitude"), textInput("attitude")),
    field("bonus_range,bonus_points", "추가 포인트", crop("bonus_range"), textInput("bonus_range", "범위"),
      el("div", { style: "margin-top:8px" }, seg("bonus_points", LABELS.bonus_points, { numeric: true }))),
    field("today_hw", "오늘 과제", crop("today_hw"), textInput("today_hw")),
    field("memo", "메모", el("textarea", { oninput: (e) => { v.memo = e.target.value; touched("memo"); } }, v.memo || "")),
    el("div", { class: "actions" },
      el("button", { class: "btn primary", onclick: save }, c.status === "saved" ? "다시 저장" : "저장"),
      c.ai_status !== "off" ? el("button", { class: "btn", onclick: reread }, "손글씨 다시 판독") : null,
      c.status === "discarded"
        ? el("button", { class: "btn", onclick: restore }, "되살리기")
        : el("button", { class: "btn danger", onclick: discard }, "버리기")));

  $content.replaceChildren(el("div", { class: "review" }, cardView, form));
  updateFlagMarks();
}

function openZoom(src) {
  const z = document.querySelector("#zoom");
  z.querySelector("img").src = src;
  z.classList.add("open");
}
document.querySelector("#zoom").addEventListener("click", (e) => e.currentTarget.classList.remove("open"));

// ---------- 동작 ----------
async function save(mode) {
  const c = state.current;
  try {
    await api(`/api/cards/${c.id}/save`, { json: { values: state.values, mode: typeof mode === "string" ? mode : null } });
  } catch (e) {
    if (e.status === 409) {
      const choice = await ask(e.message, [
        { label: "취소", value: null },
        { label: "둘 다 남기기", value: "keep_both" },
        { label: "덮어쓰기", value: "replace", cls: "primary" },
      ]);
      if (choice) return save(choice);
      return;
    }
    toast(e.message, 4000);
    return;
  }
  toast("저장했습니다");
  await nextCard(c.id);
}

async function nextCard(doneId) {
  const idx = state.cards.findIndex((x) => x.id === doneId);
  await loadList();
  if (!state.cards.length) { state.current = null; renderStrip(); return; }
  if (state.cards.some((x) => x.id === doneId)) return openCard(doneId); // 같은 목록에 남아 있으면 그대로
  const next = state.cards[Math.min(Math.max(idx, 0), state.cards.length - 1)];
  openCard(next.id);
}

async function discard() {
  const ok = await ask("이 카드를 버릴까요? (버린 카드 목록에서 되살릴 수 있습니다)", [
    { label: "취소", value: false }, { label: "버리기", value: true, cls: "primary" }]);
  if (!ok) return;
  await api(`/api/cards/${state.current.id}/discard`, { method: "POST" });
  await nextCard(state.current.id);
}

async function restore() {
  await api(`/api/cards/${state.current.id}/restore`, { method: "POST" });
  toast("확인 대기 목록으로 옮겼습니다");
  await nextCard(state.current.id);
}

async function reread() {
  try {
    await api(`/api/cards/${state.current.id}/reread`, { method: "POST" });
    for (const k of HANDWRITING_KEYS) state.touched.delete(k);
    state.current.ai_status = "waiting";
    render();
    schedulePoll();
  } catch (e) { toast(e.message, 4000); }
}

// ---------- 시작 ----------
(async () => {
  const p = params();
  state.status = p.get("status") || "pending";
  document.querySelector("#status-filter").value = state.status;
  document.querySelector("#status-filter").addEventListener("change", async (e) => {
    state.status = e.target.value;
    state.current = null;
    clearTimeout(state.poll);
    $content.replaceChildren();
    await loadList();
    if (state.cards.length) openCard(state.cards[0].id);
  });
  state.students = await api("/api/students");
  await loadList();
  const want = Number(p.get("card"));
  const first = state.cards.find((c) => c.id === want) || state.cards[0];
  if (want && !first) openCard(want);
  else if (first) openCard(first.id);
})();
