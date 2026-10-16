#!/usr/bin/env node
/*
 * 학교 주간학습안내 게시판(3~6학년)을 읽어 school-weekly-data.json을 만든다.
 * GitHub Actions(.github/workflows/school-weekly.yml)에서 정해진 시각마다 실행한다.
 *   node scripts/school-weekly-fetch.js [출력 파일]
 * 이미 받아 둔 게시물은 다시 받지 않는다. 다만 최근 3주 게시물은 수정됐을 수 있어 다시 받는다.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SW = require('../school-weekly.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'school-weekly-data.json'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const RECENT_WEEKS = 3;

async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i >= 2) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

function loadOld() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { weeks: [] }; }
}

async function main() {
  const now = new Date();
  const old = loadOld();
  const known = new Map(); // `${grade}:${seq}` → 예전 게시물 정보
  for (const w of old.weeks || []) {
    for (const [grade, p] of Object.entries(w.grades || {})) known.set(`${grade}:${p.seq}`, { ...p, grade: Number(grade), week: w.monday });
  }
  const recentFrom = SW.addDays(SW.mondayOf(now), -7 * RECENT_WEEKS);

  const posts = [...known.values()];
  const errors = [];
  for (const board of SW.BOARDS) {
    let list;
    try {
      const html = await get(SW.listUrl(board, 1));
      list = SW.parseList(html);
      if (!list.length) console.log(`${board.grade}학년 목록 응답 ${html.length}자: ${html.replace(/\s+/g, ' ').slice(0, 400)}`);
    } catch (e) {
      errors.push(`${board.grade}학년 목록: ${e.message}`);
      continue;
    }
    if (!list.length) errors.push(`${board.grade}학년 목록에서 게시물을 찾지 못했습니다`);
    for (const item of list) {
      const week = SW.weekOfTitle(item.title, now);
      if (!week) { console.warn(`날짜를 못 읽은 제목: ${board.grade}학년 "${item.title}"`); continue; }
      const key = `${board.grade}:${item.seq}`;
      const prev = known.get(key);
      const url = SW.viewUrl(board, item.seq);
      let images = prev ? prev.images : null;
      if (!prev || week >= recentFrom || !images || !images.length) {
        try {
          images = SW.pickImages(SW.parseImages(await get(url)));
        } catch (e) {
          errors.push(`${board.grade}학년 "${item.title}": ${e.message}`);
          if (!images) images = [];
        }
      }
      const post = { grade: board.grade, seq: item.seq, title: item.title, url, week, images };
      const i = posts.findIndex((p) => p.grade === board.grade && p.seq === item.seq);
      if (i >= 0) posts[i] = post; else posts.push(post);
    }
  }

  const weeks = SW.groupWeeks(posts);
  if (!weeks.length) {
    console.log('::error::모은 게시물이 없어 저장하지 않습니다');
    for (const e of errors) console.log(`::warning::${e}`);
    process.exitCode = 1;
    return;
  }
  const data = { weeks };
  const before = JSON.stringify({ weeks: old.weeks || [] });
  if (JSON.stringify(data) !== before || !old.updatedAt) {
    fs.writeFileSync(OUT, JSON.stringify({ updatedAt: now.toISOString(), weeks }, null, 1) + '\n');
    console.log(`저장: ${OUT} (${weeks.length}주)`);
  } else {
    console.log('바뀐 내용 없음');
  }
  for (const w of weeks.slice(0, 3)) {
    console.log(w.monday, Object.entries(w.grades).map(([g, p]) => `${g}학년 ${p.images.length}장`).join(', '));
  }
  // 일부 실패는 경고만 하고 받은 것은 저장한다. 네 게시판 모두 실패했을 때만 실패로 끝낸다.
  for (const e of errors) console.log(`::warning::${e}`);
  if (errors.filter((e) => e.includes('목록')).length === SW.BOARDS.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
