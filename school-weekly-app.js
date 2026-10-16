/* 주간학습안내 모아보기 화면 처리 (데이터: school-weekly-data.json, GitHub Actions가 갱신) */
(function () {
  'use strict';
  const SW = window.SchoolWeekly;
  const $ = (id) => document.getElementById(id);
  const CAPTIONS = ['주간학습계획', '학급별 시간표'];
  let weeks = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function todayUTC() {
    const d = new Date(); // 이 기기 시각 기준 오늘 날짜
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function render(monday) {
    const i = weeks.findIndex((w) => w.monday === monday);
    const w = weeks[i];
    $('week').value = monday;
    $('btn-prev').disabled = i >= weeks.length - 1; // 목록은 최신 주가 먼저
    $('btn-next').disabled = i <= 0;
    if (location.hash.slice(1) !== monday) history.replaceState(null, '', '#' + monday);
    $('list').innerHTML = SW.BOARDS.map((b) => {
      const p = w.grades[b.grade];
      if (!p) {
        return `<section class="grade"><div class="grade-head"><h2>${b.grade}학년</h2></div>` +
          `<div class="empty">이 주의 게시물이 아직 없습니다. <a href="${esc(SW.listUrl(b, 1))}" target="_blank" rel="noopener">게시판 보기</a></div></section>`;
      }
      const imgs = p.images.length
        ? p.images.map((src, k) => `<figure><figcaption>${CAPTIONS[k] || ''}</figcaption>` +
            `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${b.grade}학년 ${CAPTIONS[k] || ''}" loading="lazy" referrerpolicy="no-referrer"></a></figure>`).join('')
        : '<div class="empty">게시물에서 이미지를 찾지 못했습니다. 원본 게시물을 확인해 주세요.</div>';
      return `<section class="grade"><div class="grade-head"><h2>${b.grade}학년</h2>` +
        `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a></div>` +
        `<div class="imgs">${imgs}</div></section>`;
    }).join('');
  }

  function current() { return $('week').value; }
  function move(step) {
    const i = weeks.findIndex((w) => w.monday === current()) - step;
    if (weeks[i]) render(weeks[i].monday);
  }

  $('btn-prev').addEventListener('click', () => move(-1));
  $('btn-next').addEventListener('click', () => move(1));
  $('week').addEventListener('change', () => render(current()));
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (weeks.some((w) => w.monday === h) && h !== current()) render(h);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  });

  fetch('school-weekly-data.json?t=' + Date.now(), { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      weeks = data.weeks || [];
      if (!weeks.length) { $('list').innerHTML = '<p class="muted">아직 모은 게시물이 없습니다.</p>'; return; }
      $('week').innerHTML = weeks.map((w) => `<option value="${w.monday}">${SW.weekLabel(w.monday)}</option>`).join('');
      const h = location.hash.slice(1);
      render(weeks.some((w) => w.monday === h) ? h : SW.defaultWeek(weeks, todayUTC()));
      if (data.updatedAt) {
        const t = new Date(data.updatedAt);
        $('info').textContent = `학교 홈페이지 게시판에서 자동으로 모읍니다 (마지막 변경: ${t.toLocaleString('ko-KR')}). ` +
          '이미지를 누르면 크게 볼 수 있습니다. 키보드 ←/→로 주를 넘길 수 있습니다.';
      }
    })
    .catch((e) => { $('list').innerHTML = `<p class="err">데이터를 불러오지 못했습니다: ${esc(e.message)}</p>`; });
})();
