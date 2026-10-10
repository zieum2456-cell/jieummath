/*
 * 화면 미리 보기 (개발용): 가짜 Apps Script 환경 위에서 Code.gs를 돌리고 화면을 띄운다.
 *   node progress-card/tests/preview.js [포트]  →  http://localhost:8787
 * 구글 시트·드라이브 대신 메모리에 저장하므로 끄면 사라진다.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('./fake-gas.js');

const DIR = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 8787;
const g = loadGas({
  payment: {
    students: [
      { no: '56', name: '김도윤', grade: '초4' },
      { no: '43', name: '이지아', grade: '초5' },
      { no: '73', name: '박채아', grade: '초4' },
      { no: '', name: '번호없는학생', grade: '초3' },
    ],
  },
});
g.ctx.setup();

const SHIM = `<script>
window.google = { script: { get run() {
  let ok = () => {}, fail = () => {};
  const p = new Proxy({}, { get(_, k) {
    if (k === 'withSuccessHandler') return (f) => { ok = f; return p; };
    if (k === 'withFailureHandler') return (f) => { fail = f; return p; };
    return (...args) => fetch('/run/' + k, { method: 'POST', body: JSON.stringify(args) })
      .then((r) => r.json()).then((j) => (j.error ? fail(new Error(j.error)) : ok(j.result)), fail);
  } });
  return p;
} } };
</script>`;

function page() {
  const read = (n) => fs.readFileSync(path.join(DIR, n + '.html'), 'utf8');
  return read('Index')
    .replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' + SHIM)
    .replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => read(n));
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  const m = req.url.match(/^\/run\/(api_\w+)$/);
  if (req.method === 'POST' && m) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let out;
      try {
        out = { result: JSON.parse(JSON.stringify(g.ctx[m[1]](...JSON.parse(body)) ?? null)) };
      } catch (e) {
        out = { error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, () => console.log(`미리 보기: http://localhost:${port}`));
