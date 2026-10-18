/* 주간학습안내 모아보기 화면 처리 (데이터: school-weekly-data.json, GitHub Actions가 갱신) */
(function () {
  'use strict';
  const SW = window.SchoolWeekly;
  const $ = (id) => document.getElementById(id);
  const SW_DAYS = ['월', '화', '수', '목', '금'];
  let weeks = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function todayUTC() {
    const d = new Date(); // 이 기기 시각 기준 오늘 날짜
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function figure(caption, src, alt, href) {
    return `<figure><figcaption>${caption}</figcaption><a href="${esc(href || src)}" target="_blank" rel="noopener">` +
      `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"></a></figure>`;
  }

  // 왼쪽: 주간학습계획의 수학 줄 + 가정통신 줄 (못 잘랐으면 원본)
  function planView(b, p, x) {
    if (x && x.plan) return figure('주간학습계획 · 수학, 가정통신', x.plan, `${b.grade}학년 주간학습계획 수학`, p.images[0]);
    return figure('주간학습계획', p.images[0], `${b.grade}학년 주간학습계획`);
  }

  // 오른쪽: 반 × 월~금 표에 수학이 있는 칸 표시 (못 읽었으면 원본 시간표)
  function mathView(b, p, x) {
    if (!(x && x.math && Object.keys(x.math).length)) {
      const src = p.images[SW.timetableIndex(x)];
      return src ? figure('학급별 시간표', src, `${b.grade}학년 학급별 시간표`) : '';
    }
    const guessed = new Set((x.guessed || []).map(String));
    const classes = Object.keys(x.math).sort((a, c) => a - c);
    const rows = classes.map((k) => `<tr><th>${k}반${guessed.has(k) ? ' <span class="guess">(추정)</span>' : ''}</th>` +
      SW_DAYS.map((d) => x.math[k].includes(d) ? '<td class="on">수학</td>' : '<td></td>').join('') + '</tr>').join('');
    return `<figure><figcaption>반별 수학 요일</figcaption><table class="math">` +
      `<thead><tr><th>반</th>${SW_DAYS.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>` +
      (guessed.size ? '<p class="muted">(추정): 반 번호를 읽지 못해 앞 반 다음 번호로 짐작했습니다. 원본 시간표로 확인해 주세요.</p>' : '') +
      '</figure>';
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
      const x = SW.currentExtract(p);
      const tt = SW.timetableIndex(x);
      const caption = (k) => (k === 0 ? '주간학습계획' : k === tt ? '학급별 시간표' : '이미지 ' + (k + 1));
      const links = p.images.map((src, k) => `<a href="${esc(src)}" target="_blank" rel="noopener">${caption(k)}</a>`).join(' · ');
      return `<section class="grade"><div class="grade-head"><h2>${b.grade}학년</h2>` +
        `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a>` +
        (p.images.length ? `<span class="orig">원본 보기: ${links}</span>` : '') + '</div>' +
        (p.images.length
          ? `<div class="imgs${x && x.math ? ' cut' : ''}">${planView(b, p, x)}${mathView(b, p, x)}</div>`
          : '<div class="empty">게시물에서 이미지를 찾지 못했습니다. 원본 게시물을 확인해 주세요.</div>') +
        '</section>';
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
          '이미지를 누르면 원본을 크게 볼 수 있습니다. 키보드 ←/→로 주를 넘길 수 있습니다.';
      }
    })
    .catch((e) => { $('list').innerHTML = `<p class="err">데이터를 불러오지 못했습니다: ${esc(e.message)}</p>`; });
})();
