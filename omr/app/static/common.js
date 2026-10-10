// 여러 화면에서 같이 쓰는 함수
const LABELS = {
  attendance: { regular: "정규", absent: "결강", makeup: "보강" },
  last_hw: { done: "완료", partial: "미완", none: "안 함", forgot: "두고 옴", no_hw: "과제 없음" },
  stages: { concept: "개념", type: "유형", unit_review: "단원마무리", wrong_note: "교재오답", test: "Test", contest: "경시" },
  progress: { lt50: "50% 미만", "50_75": "50~75%", "75_100": "75~100%" },
  error_causes: { calc: "계산 실수", concept: "개념 이해 부족", condition: "조건 놓침(문제 읽기)", skip_steps: "풀이 과정 생략" },
  bonus_points: { 0: "0", 3: "3", 6: "6", 9: "9" },
  color: { green: "초록", blue: "파랑", red: "빨강", black: "검정", unknown: "모름" },
  mark: { circle: "○ 끝냄", triangle: "△ 덜함", none: "표시 없음" },
};

async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `오류 ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg, ms = 2500) {
  let t = document.querySelector(".toast");
  if (!t) { t = el("div", { class: "toast" }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}

async function refreshPendingBadge() {
  try {
    const s = await api("/api/status");
    const b = document.querySelector("#pending-badge");
    if (b) b.textContent = s.pending ? s.pending : "";
    return s;
  } catch (e) { return null; }
}

// 확인 창: 버튼 목록 중 하나를 고르면 그 값으로 끝난다
function ask(message, buttons) {
  return new Promise((resolve) => {
    const modal = el("div", { class: "modal open" },
      el("div", { class: "box" },
        el("div", {}, message),
        el("div", { class: "row" }, buttons.map((b) =>
          el("button", { class: "btn " + (b.cls || ""), onclick: () => { modal.remove(); resolve(b.value); } }, b.label)))));
    document.body.append(modal);
  });
}
