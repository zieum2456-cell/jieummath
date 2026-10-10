/*
 * 테스트용 가짜 Apps Script 환경 (SpreadsheetApp, DriveApp 등 Code.gs가 쓰는 만큼만)
 * Code.gs를 Node에서 실행해 저장 흐름을 검사하고, tests/preview.js로 화면을 띄워 보는 데 쓴다.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

let seq = 0;
const newId = (p) => `${p}${++seq}`;
const toSigned = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
const toBuffer = (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256));

class Range {
  constructor(sheet, r, c, nr, nc) {
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  setValues(values) {
    if (values.length !== this.nr || values.some((row) => row.length !== this.nc)) throw new Error('setValues: 크기가 맞지 않음');
    if (this.r + this.nr - 1 > this.sheet.maxRows) throw new Error('setValues: 시트 행 수를 넘음');
    values.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) {
    this.sheet.set(this.r, this.c, v);
    return this;
  }
  getDisplayValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = this.sheet.get(this.r + i, this.c + j);
        row.push(v == null ? '' : String(v));
      }
      out.push(row);
    }
    return out;
  }
  setNumberFormats() { return this; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.maxRows = 1000;
    this.failNextWrite = false;
  }
  key(r, c) { return r + ',' + c; }
  set(r, c, v) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('가짜 쓰기 오류');
    }
    if (v === '' || v == null) this.cells.delete(this.key(r, c));
    else this.cells.set(this.key(r, c), v);
  }
  get(r, c) { return this.cells.get(this.key(r, c)); }
  getName() { return this.name; }
  getLastRow() {
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0]));
    return m;
  }
  getLastColumn() {
    let m = 0;
    for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1]));
    return m;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) {
    const r = this.getLastRow() + 1;
    row.forEach((v, j) => this.set(r, j + 1, v));
  }
  setFrozenRows() {}
  setFrozenColumns() {}
  setColumnWidth() {}
  /** 테스트용: [{열이름: 값}] */
  objects() {
    const v = this.getDataRange().getDisplayValues();
    return v.slice(1).map((r) => Object.fromEntries(v[0].map((h, i) => [h, r[i]])));
  }
}

class Spreadsheet {
  constructor() {
    this.id = newId('ss');
    this.sheets = [new Sheet('시트1')];
  }
  getId() { return this.id; }
  getName() { return '진도카드 기록'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) {
    const s = new Sheet(n);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return [...this.sheets]; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

const iter = (arr) => {
  let i = 0;
  return { hasNext: () => i < arr.length, next: () => arr[i++] };
};

class File {
  constructor(blob) {
    this.id = newId('file');
    this.blob = blob;
  }
  getId() { return this.id; }
  getName() { return this.blob.name; }
  getUrl() { return 'https://drive.google.com/file/d/' + this.id; }
  getBlob() { return this.blob; }
}

class Folder {
  constructor(drive, name) {
    this.drive = drive;
    this.id = newId('folder');
    this.name = name;
    this.folders = [];
    this.files = [];
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
  isTrashed() { return false; }
  getFoldersByName(n) { return iter(this.folders.filter((f) => f.name === n)); }
  createFolder(n) {
    const f = new Folder(this.drive, n);
    this.folders.push(f);
    this.drive.all.set(f.id, f);
    return f;
  }
  getFilesByName(n) { return iter(this.files.filter((f) => f.getName() === n)); }
  createFile(blob) {
    if (this.drive.failNext) {
      this.drive.failNext = false;
      throw new Error('가짜 드라이브 오류');
    }
    const f = new File(blob);
    this.files.push(f);
    this.drive.all.set(f.id, f);
    return f;
  }
}

function makeBlob(bytes, type, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : toBuffer(bytes);
  return { name, type, buf, getDataAsString: () => buf.toString('utf8') };
}

/**
 * Code.gs를 가짜 환경에 올린다.
 * opts.payment: 결제일 관리 앱 state (Firestore 응답 흉내) / opts.firestoreStatus: 응답 코드
 */
function loadGas(opts = {}) {
  const ss = new Spreadsheet();
  const props = {};
  const drive = { all: new Map(), failNext: false };
  const root = new Folder(drive, '내 드라이브');
  const fetchLog = [];
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: (id) => { if (id !== ss.id) throw new Error('없는 시트'); return ss; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => (props[k] = v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'teacher@example.com' }) },
    Logger: { log: () => {} },
    DriveApp: {
      getFolderById: (id) => { const f = drive.all.get(id); if (!f) throw new Error('없는 폴더'); return f; },
      getFileById: (id) => { const f = drive.all.get(id); if (!f) throw new Error('없는 파일'); return f; },
      getFoldersByName: (n) => root.getFoldersByName(n),
      createFolder: (n) => root.createFolder(n),
    },
    Utilities: {
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      computeDigest: (alg, bytes) => toSigned(crypto.createHash('md5').update(toBuffer(bytes)).digest()),
      DigestAlgorithm: { MD5: 'MD5' },
      newBlob: makeBlob,
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: {
      fetch: (url, o) => {
        fetchLog.push({ url, o });
        const code = opts.firestoreStatus || 200;
        const body = code === 200
          ? JSON.stringify([
            { document: { name: 'projects/jieummath/databases/(default)/documents/users/u1/apps/timetable', fields: { json: { stringValue: '{}' } }, updateTime: '2026-10-09T00:00:00Z' } },
            { document: { name: 'projects/jieummath/databases/(default)/documents/users/u1/apps/payment', fields: { json: { stringValue: JSON.stringify(opts.payment || { students: [] }) } }, updateTime: '2026-10-10T00:00:00Z' } },
          ])
          : JSON.stringify({ error: { message: 'Permission denied' } });
        return { getResponseCode: () => code, getContentText: () => body };
      },
    },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, ss, drive, root, fetchLog };
}

module.exports = { loadGas };
