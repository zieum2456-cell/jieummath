const test = require('node:test');
const assert = require('node:assert/strict');
const SW = require('../school-weekly.js');

const REF = new Date(Date.UTC(2026, 9, 16)); // 2026-10-16 (금)

test('학년마다 다른 제목 양식에서 그 주 월요일 구하기', () => {
  const cases = [
    ['10월 12일~10월 16일 주간학습안내(2학기 9주)', '2026-10-12'],
    ['7월 20일~7월 24일 주간학습안내(1학기 21주)', '2026-07-20'],
    ['4학년- 10월 19일 ~ 10월 23(10주)', '2026-10-19'],
    ['4학년-8월18일 ~ 8월 21일(1주)', '2026-08-17'],
    ['5학년_10월19일 - 10월23일(10주)', '2026-10-19'],
    ['5학년_ 8월18일 - 8월21일(1주)', '2026-08-17'],
    ['6학년 2학기 10주 (10.19~10.23) 주간학습안내', '2026-10-19'],
    ['6학년 2학기 7주 (9.29~10.2) 주간학습안내', '2026-09-28'],
    ['6학년 2학기 2주 8.24~8.28 주간학습안내', '2026-08-24'],
  ];
  for (const [title, monday] of cases) assert.equal(SW.weekOfTitle(title, REF), monday, title);
  assert.equal(SW.weekOfTitle('공지사항', REF), null);
});

test('연도는 기준일에 가까운 해로 정한다 (연말·연초)', () => {
  const dec = new Date(Date.UTC(2026, 11, 30));
  assert.equal(SW.weekOfTitle('1월 4일~1월 8일 주간학습안내', dec), '2027-01-04');
  const jan = new Date(Date.UTC(2027, 0, 2));
  assert.equal(SW.weekOfTitle('12월 28일~12월 31일', jan), '2026-12-28');
});

test('목록 페이지에서 게시물 번호와 제목 읽기', () => {
  const html = `
<a id="subject_34225264" href="#contents" border="0" title="10월 12일~10월 16일 주간학습안내(2학기 9주)" onclick="javascript:goView('306002','306002','34225264', '0', 'null', 'W', '1', 'N', '')" onkeypress='' style='text-decoration: none;'>
<a id="subject_34204294" href="#contents" border="0" title="10월 5일~10월 9일 &amp; 안내" onclick="">`;
  assert.deepEqual(SW.parseList(html), [
    { seq: '34225264', title: '10월 12일~10월 16일 주간학습안내(2학기 9주)' },
    { seq: '34204294', title: '10월 5일~10월 9일 & 안내' },
  ]);
});

const VIEW = (imgs) => `
<p><img src="/images/template/10025/sub/S_visual.png" alt=""/></p>
<table class="bbsView"><tbody><tr><td class="conts" colspan="2">
<div class="conts">
<p>안내입니다.<br></p>${imgs}
</div></td></tr>
<tr><th>첨부파일</th><td><p><a href='/boardCnts/fileDown.do?fileSeq=1' class="filedownNM">a.pdf</a></p></td></tr>
</tbody></table>
<img src="/upload/footer/banner.png">`;

test('본문 이미지 3장이면 앞의 2장(주간학습계획, 학급별 시간표)만', () => {
  const html = VIEW(
    '<p><img src="https://haedeun.icees.kr/upload/keditor/haden/306006/2026/10/a.jpg" style="width: 754px;">' +
    '<img src="https://haedeun.icees.kr/upload/keditor/haden/306006/2026/10/b.jpg" style="font-size: 10pt;">' +
    '<img src="https://haedeun.icees.kr/upload/keditor/haden/306006/2026/10/c.jpg"></p>');
  const all = SW.parseImages(html);
  assert.equal(all.length, 3);
  assert.deepEqual(SW.pickImages(all), [
    'https://haedeun.icees.kr/upload/keditor/haden/306006/2026/10/a.jpg',
    'https://haedeun.icees.kr/upload/keditor/haden/306006/2026/10/b.jpg',
  ]);
});

test('본문 이미지 2장이면 2장 모두, 상대 주소는 사이트 주소로 바꾼다', () => {
  const html = VIEW('<p><img src="/upload/keditor/haden/306008/x.png"></p><p><img src="/upload/keditor/haden/306008/y.png"></p>');
  assert.deepEqual(SW.pickImages(SW.parseImages(html)), [
    'https://haedeun.icees.kr/upload/keditor/haden/306008/x.png',
    'https://haedeun.icees.kr/upload/keditor/haden/306008/y.png',
  ]);
});

test('5학년은 첫 번째와 세 번째 이미지(반별 시간표)를 쓰고, 2장뿐이면 앞의 2장', () => {
  const g5 = SW.BOARDS.find((b) => b.grade === 5);
  assert.deepEqual(SW.pickImages(['a', 'b', 'c'], g5), ['a', 'c']);
  assert.deepEqual(SW.pickImages(['a', 'b'], g5), ['a', 'b']);
  assert.deepEqual(SW.pickImages(['a', 'b', 'c'], SW.BOARDS.find((b) => b.grade === 3)), ['a', 'b']);
});

test('같은 주차끼리 묶고 최신 주가 먼저, 같은 주 같은 학년은 나중 글', () => {
  const weeks = SW.groupWeeks([
    { grade: 3, seq: '10', title: 'a', week: '2026-10-12', images: ['1'] },
    { grade: 4, seq: '11', title: 'b', week: '2026-10-12', images: [] },
    { grade: 4, seq: '20', title: 'c', week: '2026-10-19', images: ['2'] },
    { grade: 4, seq: '21', title: 'd', week: '2026-10-19', images: ['3'] },
    { grade: 5, seq: '22', title: 'e', week: null, images: [] },
  ]);
  assert.deepEqual(weeks.map((w) => w.monday), ['2026-10-19', '2026-10-12']);
  assert.equal(weeks[0].grades[4].seq, '21');
  assert.deepEqual(Object.keys(weeks[1].grades), ['3', '4']);
});

test('처음 보여 줄 주: 평일은 이번 주, 주말은 다음 주(있으면)', () => {
  const weeks = [{ monday: '2026-10-19' }, { monday: '2026-10-12' }, { monday: '2026-10-05' }];
  assert.equal(SW.defaultWeek(weeks, new Date(Date.UTC(2026, 9, 14))), '2026-10-12'); // 수
  assert.equal(SW.defaultWeek(weeks, new Date(Date.UTC(2026, 9, 17))), '2026-10-19'); // 토
  assert.equal(SW.defaultWeek(weeks.slice(1), new Date(Date.UTC(2026, 9, 17))), '2026-10-12'); // 다음 주 글 없음
  assert.equal(SW.defaultWeek(weeks, new Date(Date.UTC(2026, 10, 30))), '2026-10-19'); // 글이 없는 먼 미래
  assert.equal(SW.defaultWeek([], REF), null);
});

test('주 표시', () => {
  assert.equal(SW.weekLabel('2026-10-19'), '10월 19일(월) ~ 10월 23일(금)');
  assert.equal(SW.weekLabel('2026-12-28'), '12월 28일(월) ~ 1월 1일(금)');
});
