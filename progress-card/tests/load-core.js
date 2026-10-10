// Core.html의 <script> 안쪽을 꺼내 Node에서 불러온다 (Apps Script에는 .html 파일로 넣어야 해서)
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const html = fs.readFileSync(path.join(__dirname, '..', 'Core.html'), 'utf8');
const code = html.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
const m = new Module('Core.html');
m._compile(code, path.join(__dirname, '..', 'Core.html'));
module.exports = m.exports;
