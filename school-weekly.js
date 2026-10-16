/*
 * 학교 주간학습안내 모아보기: 게시판 HTML 해석 로직 (수집 스크립트와 Node 테스트, 브라우저에서 함께 사용)
 *
 * 게시판마다 제목 양식이 다르다.
 *   3학년: "10월 12일~10월 16일 주간학습안내(2학기 9주)"
 *   4학년: "4학년- 10월 19일 ~ 10월 23(10주)", "4학년-8월18일 ~ 8월 21일(1주)"
 *   5학년: "5학년_10월19일 - 10월23일(10주)"
 *   6학년: "6학년 2학기 10주 (10.19~10.23) 주간학습안내", "6학년 2학기 2주 8.24~8.28 주간학습안내"
 * 제목에 처음 나오는 날짜(시작일)로 그 주의 월요일을 구해 같은 주차끼리 묶는다.
 *
 * 게시물 본문 이미지는 2장 또는 3장이다.
 *   3장: 주간학습계획, 학급별 시간표, 교과별 시간표
 *   2장: 주간학습계획, 학급별+교과별 시간표
 * 어느 경우든 앞의 2장(주간학습계획, 학급별 시간표)만 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SchoolWeekly = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SITE = 'https://haedeun.icees.kr';
  const BOARDS = [
    { grade: 3, boardID: '306002', m: '020503' },
    { grade: 4, boardID: '306004', m: '020504' },
    { grade: 5, boardID: '306006', m: '020505' },
    { grade: 6, boardID: '306008', m: '020506' },
  ];
  const KEEP_IMAGES = 2;

  function listUrl(board, page) {
    return `${SITE}/boardCnts/list.do?boardID=${board.boardID}&m=${board.m}&s=haden${page > 1 ? '&page=' + page : ''}`;
  }

  function viewUrl(board, seq) {
    return `${SITE}/boardCnts/view.do?boardID=${board.boardID}&viewBoardID=${board.boardID}&boardSeq=${seq}` +
      `&lev=0&action=view&searchType=S&statusYN=W&page=1&m=${board.m}&s=haden`;
  }

  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]);
  }

  // 목록 페이지 → [{ seq, title }]
  function parseList(html) {
    const posts = [];
    const seen = new Set();
    const re = /<a\b[^>]*\bid="subject_(\d+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const t = /\btitle="([^"]*)"/.exec(m[0]);
      if (!t || seen.has(m[1])) continue;
      seen.add(m[1]);
      posts.push({ seq: m[1], title: decodeEntities(t[1]).trim() });
    }
    return posts;
  }

  // 제목에 처음 나오는 "M월 D일" 또는 "M.D" → { month, day }
  function titleStart(title) {
    const m = /(\d{1,2})\s*(?:월\s*|\.)(\d{1,2})(?!\d)/.exec(title);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { month, day };
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

  // 그 날짜가 속한 주의 월요일 (UTC 날짜로 계산, 'YYYY-MM-DD')
  function mondayOf(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dow = (d.getUTCDay() + 6) % 7; // 월=0 ... 일=6
    d.setUTCDate(d.getUTCDate() - dow);
    return ymd(d);
  }

  // 제목 → 그 주 월요일. 연도는 기준일(ref)에 가장 가까운 해로 정한다.
  function weekOfTitle(title, ref) {
    const s = titleStart(title);
    if (!s) return null;
    const base = ref.getUTCFullYear();
    let best = null;
    for (const y of [base - 1, base, base + 1]) {
      const d = new Date(Date.UTC(y, s.month - 1, s.day));
      if (d.getUTCMonth() !== s.month - 1) continue; // 2월 30일 같은 날짜
      const diff = Math.abs(d - ref);
      if (!best || diff < best.diff) best = { d, diff };
    }
    return best ? mondayOf(best.d) : null;
  }

  // 게시물 페이지 → 본문 이미지 주소 (게시판에 올린 이미지만, 순서대로)
  function parseImages(html) {
    // 본문 칸(<div class="conts">)부터 첨부파일 칸 앞까지만 본다
    const start = html.search(/<div class="conts">/);
    if (start >= 0) {
      html = html.slice(start);
      const end = html.search(/<th>\s*첨부파일/);
      if (end >= 0) html = html.slice(0, end);
    }
    const urls = [];
    const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      let src = decodeEntities(m[1].trim());
      if (!/\/upload\//.test(src)) continue;
      if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/')) src = SITE + src;
      if (!urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  function pickImages(urls) {
    return urls.slice(0, KEEP_IMAGES);
  }

  // 학년별 게시물 → 주차별로 묶기. posts: [{ grade, seq, title, week, images }]
  function groupWeeks(posts) {
    const map = new Map();
    for (const p of posts) {
      if (!p.week) continue;
      if (!map.has(p.week)) map.set(p.week, { monday: p.week, grades: {} });
      const g = map.get(p.week).grades;
      // 같은 주에 글이 여럿이면 나중 글(번호가 큰 글)을 쓴다
      if (!g[p.grade] || Number(p.seq) > Number(g[p.grade].seq)) {
        g[p.grade] = { seq: p.seq, title: p.title, url: p.url, images: p.images || [] };
      }
    }
    return [...map.values()].sort((a, b) => (a.monday < b.monday ? 1 : -1));
  }

  function addDays(monday, n) {
    const [y, mo, d] = monday.split('-').map(Number);
    return ymd(new Date(Date.UTC(y, mo - 1, d + n)));
  }

  // 처음 보여 줄 주: 오늘이 속한 주. 토·일요일이면 다음 주가 있으면 다음 주. 없으면 가장 가까운 주.
  function defaultWeek(weeks, today) {
    if (!weeks.length) return null;
    const dow = (today.getUTCDay() + 6) % 7;
    let target = mondayOf(today);
    if (dow >= 5) {
      const next = addDays(target, 7);
      if (weeks.some((w) => w.monday === next)) target = next;
    }
    if (weeks.some((w) => w.monday === target)) return target;
    const past = weeks.filter((w) => w.monday <= target);
    return (past[0] || weeks[weeks.length - 1]).monday;
  }

  function weekLabel(monday) {
    const fri = addDays(monday, 4);
    const f = (s) => `${Number(s.slice(5, 7))}월 ${Number(s.slice(8, 10))}일`;
    return `${f(monday)}(월) ~ ${f(fri)}(금)`;
  }

  return {
    SITE, BOARDS, KEEP_IMAGES, listUrl, viewUrl, parseList, titleStart, mondayOf, weekOfTitle,
    parseImages, pickImages, groupWeeks, addDays, defaultWeek, weekLabel,
  };
});
