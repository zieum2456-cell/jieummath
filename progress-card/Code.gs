/*
 * 진도 카드 기록 — 서버 쪽 (Google Apps Script)
 *
 * 처음 한 번: 편집기 위쪽 함수 목록에서 setup 을 고르고 [실행] → 권한 승인.
 *   시트 탭(학생명단·수업기록·업로드이력·설정)과 드라이브 폴더(진도카드 원본)를 만든다.
 * 화면(Index.html)에서는 google.script.run 으로 api_ 로 시작하는 함수만 부른다.
 */

const TZ = 'Asia/Seoul';

// Core.html 의 HEADERS 와 같아야 한다 (CSV 열 순서)
const CSV_HEADERS = ['수업일', '학생번호', '이름', '출결', '등원', '하원', '수업시간(분)', '지난과제', '단계', '진행률', '오답원인', '추가포인트',
  '지난과제범위', '오늘진도범위', '추가포인트범위', '오늘과제', '학습태도', '확인필요'];

const SHEETS = {
  roster: {
    name: '학생명단',
    headers: ['학생번호', '이름', '학년', '디딤돌레벨', '발송조', '상태', '메모', '수정일시'],
    widths: [70, 90, 60, 110, 60, 60, 200, 140],
  },
  records: {
    name: '수업기록',
    headers: ['기록ID'].concat(CSV_HEADERS, ['확인필요상태', '해결일시', '수정한칸', '검사메모', '업로드ID', '원본파일명', '저장일시', '수정일시']),
    numbers: ['수업시간(분)', '추가포인트'],
    widths: [130, 90, 70, 70, 50, 55, 55, 70, 70, 120, 80, 140, 70, 160, 220, 160, 180, 240, 240, 80, 140, 120, 200, 150, 180, 140, 140],
    freezeCols: 4,
  },
  uploads: {
    name: '업로드이력',
    headers: ['업로드ID', '업로드일시', '파일명', '수업일', '카드수', '확인필요카드', '저장', '덮어씀', '건너뜀', '남은카드', '상태',
      '처리내역', '원본파일', '원본파일ID', '파일해시', '마지막처리일시', '오류'],
    numbers: ['카드수', '확인필요카드', '저장', '덮어씀', '건너뜀', '남은카드'],
    widths: [150, 140, 180, 90, 50, 80, 45, 50, 50, 60, 80, 300, 200, 120, 120, 140, 200],
  },
  settings: {
    name: '설정',
    headers: ['항목', '값', '설명'],
    widths: [160, 200, 500],
  },
};

const DEFAULT_SETTINGS = [
  ['두고옴처리', '안 함과 같이(×0)', '과제 완료율 계산 때 "두고 옴"을 어떻게 셀지: 안 함과 같이(×0) / 미완과 같이(×0.5) / 계산에서 제외'],
  ['원본폴더ID', '', '업로드한 원본 CSV를 보관하는 구글 드라이브 폴더 (처음 설정 때 자동으로 채워짐)'],
  ['파이어베이스프로젝트ID', 'jieummath', '결제일 관리 앱이 쓰는 Firebase 프로젝트 ID (명단 자동 불러오기에 사용)'],
];
const DONE_OPTIONS = ['안 함과 같이(×0)', '미완과 같이(×0.5)', '계산에서 제외'];
const PENDING = ['확인 대기', '일부 저장'];
const ROOT_FOLDER_NAME = '진도카드 원본';
const EXPORT_FOLDER_NAME = '진도카드 내보내기';

/* ---------- 웹 앱 ---------- */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('진도 카드')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ---------- 처음 설정 ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('구글 시트의 [확장 프로그램 → Apps Script]에서 만든 프로젝트에서 실행해 주세요.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureSheets_(ss);
  const folder = rootFolder_();
  const msg = `설정 완료: 시트 "${ss.getName()}", 원본 폴더 "${folder.getName()}" (${folder.getUrl()})`;
  Logger.log(msg);
  return msg;
}

function ss_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  let ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('아직 처음 설정을 하지 않았습니다. Apps Script 편집기에서 setup 함수를 한 번 실행해 주세요.');
  if (!id) props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function ensureSheets_(ss) {
  Object.keys(SHEETS).forEach((k) => {
    const def = SHEETS[k];
    let sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold').setBackground('#eef2ff');
      sh.setFrozenRows(1);
      if (def.freezeCols) sh.setFrozenColumns(def.freezeCols);
      // 학생번호 앞 0, 날짜·시각이 자동 변환되지 않게 글자 서식으로 고정
      def.headers.forEach((h, i) => {
        sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat((def.numbers || []).indexOf(h) >= 0 ? '0' : '@');
        if (def.widths && def.widths[i]) sh.setColumnWidth(i + 1, def.widths[i]);
      });
    }
  });
  const st = ss.getSheetByName(SHEETS.settings.name);
  const have = st.getDataRange().getDisplayValues().map((r) => r[0]);
  DEFAULT_SETTINGS.forEach((row) => {
    if (have.indexOf(row[0]) < 0) st.appendRow(row);
  });
  // 새 시트에 처음부터 있던 빈 탭(시트1) 정리
  ss.getSheets().forEach((sh) => {
    const known = Object.keys(SHEETS).some((k) => SHEETS[k].name === sh.getName());
    if (!known && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

/* ---------- 시트 읽기/쓰기 도우미 ---------- */

function sheet_(key) {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEETS[key].name);
  if (!sh) {
    ensureSheets_(ss);
    sh = ss.getSheetByName(SHEETS[key].name);
  }
  return sh;
}

/** 탭 전체를 [{열이름: 값}] 으로 (값은 화면에 보이는 글자 그대로). _row 는 시트 행 번호 */
function readObjects_(key) {
  const sh = sheet_(key);
  const values = sh.getDataRange().getDisplayValues();
  const head = values[0] || [];
  return values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => (o[h] = r[j]));
    return o;
  });
}

function toRow_(key, obj) {
  const def = SHEETS[key];
  return def.headers.map((h) => {
    const v = obj[h];
    if ((def.numbers || []).indexOf(h) >= 0) return v === '' || v == null || isNaN(Number(v)) ? '' : Number(v);
    return v == null ? '' : String(v);
  });
}

function formats_(key, n) {
  const def = SHEETS[key];
  const row = def.headers.map((h) => ((def.numbers || []).indexOf(h) >= 0 ? '0' : '@'));
  const out = [];
  for (let i = 0; i < n; i++) out.push(row);
  return out;
}

function appendObjects_(key, objs) {
  if (!objs.length) return;
  const sh = sheet_(key);
  const width = SHEETS[key].headers.length;
  const start = sh.getLastRow() + 1;
  const need = start + objs.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  const range = sh.getRange(start, 1, objs.length, width);
  range.setNumberFormats(formats_(key, objs.length));
  range.setValues(objs.map((o) => toRow_(key, o)));
}

function writeObject_(key, row, obj) {
  const sh = sheet_(key);
  const range = sh.getRange(row, 1, 1, SHEETS[key].headers.length);
  range.setNumberFormats(formats_(key, 1));
  range.setValues([toRow_(key, obj)]);
}

const now_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');

function settings_() {
  const out = {};
  readObjects_('settings').forEach((r) => {
    if (r.항목) out[r.항목] = r.값;
  });
  return out;
}

function setSetting_(name, value) {
  const rows = readObjects_('settings');
  const r = rows.find((x) => x.항목 === name);
  const sh = sheet_('settings');
  if (r) sh.getRange(r._row, 2).setValue(value);
  else sh.appendRow([name, value, '']);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 저장 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 드라이브 ---------- */

function rootFolder_() {
  const id = settings_().원본폴더ID;
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) {
      // 지워졌거나 접근 불가 → 새로 만든다
    }
  }
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
  setSetting_('원본폴더ID', folder.getId());
  return folder;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function uniqueName_(folder, name) {
  if (!folder.getFilesByName(name).hasNext()) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const n = `${stem}_${i}${ext}`;
    if (!folder.getFilesByName(n).hasNext()) return n;
  }
}

/* ---------- 화면에서 부르는 함수 ---------- */

function rosterList_() {
  return readObjects_('roster')
    .filter((r) => r.학생번호)
    .map((r) => ({ no: r.학생번호, name: r.이름, grade: r.학년, level: r.디딤돌레벨, group: r.발송조, status: r.상태 || '재원', memo: r.메모 }));
}

function api_init() {
  const ss = ss_();
  const st = settings_();
  let folderUrl = '';
  try {
    folderUrl = st.원본폴더ID ? DriveApp.getFolderById(st.원본폴더ID).getUrl() : '';
  } catch (e) {
    folderUrl = '';
  }
  return {
    email: Session.getActiveUser().getEmail(),
    roster: rosterList_(),
    settings: st,
    doneOptions: DONE_OPTIONS,
    links: { sheet: ss.getUrl(), folder: folderUrl },
  };
}

/**
 * CSV 원본을 드라이브에 보관하고 업로드이력에 "확인 대기"로 올린다.
 * 같은 내용의 파일이 이미 확인 대기 중이면 새로 만들지 않는다.
 * p: { fileName, b64, classDate, cardCount, reviewCount }
 */
function api_registerUpload(p) {
  return withLock_(() => {
    const bytes = Utilities.base64Decode(p.b64);
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
      .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
    const logs = readObjects_('uploads');
    const pending = logs.find((r) => r.파일해시 === hash && PENDING.indexOf(r.상태) >= 0);
    if (pending) return { uploadId: pending.업로드ID, fileUrl: pending.원본파일, duplicate: 'pending' };
    const saved = logs.find((r) => r.파일해시 === hash && r.상태 === '저장 완료');

    const month = /^\d{4}-\d{2}/.test(p.classDate || '') ? p.classDate.slice(0, 7) : Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
    const folder = subFolder_(rootFolder_(), month);
    const name = uniqueName_(folder, p.fileName);
    const file = folder.createFile(Utilities.newBlob(bytes, 'text/csv', name));

    const uploadId = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + '-' + Math.random().toString(36).slice(2, 5);
    appendObjects_('uploads', [{
      업로드ID: uploadId, 업로드일시: now_(), 파일명: name, 수업일: p.classDate || '', 카드수: p.cardCount, 확인필요카드: p.reviewCount,
      저장: 0, 덮어씀: 0, 건너뜀: 0, 남은카드: p.cardCount, 상태: '확인 대기', 처리내역: '',
      원본파일: file.getUrl(), 원본파일ID: file.getId(), 파일해시: hash, 마지막처리일시: '', 오류: '',
    }]);
    return { uploadId, fileUrl: file.getUrl(), storedName: name, duplicate: saved ? 'saved' : '' };
  });
}

/** 확인 대기 중인 업로드 목록 + 원본 CSV 내용 */
function api_pending() {
  return readObjects_('uploads')
    .filter((r) => PENDING.indexOf(r.상태) >= 0)
    .map((r) => {
      const item = {
        uploadId: r.업로드ID, fileName: r.파일명, classDate: r.수업일, uploadedAt: r.업로드일시, status: r.상태, fileUrl: r.원본파일,
        handledRows: (r.처리내역.match(/(\d+)행/g) || []).map((s) => Number(s.replace('행', ''))),
        text: null, error: '',
      };
      try {
        item.text = DriveApp.getFileById(r.원본파일ID).getBlob().getDataAsString('UTF-8');
      } catch (e) {
        item.error = '드라이브에서 원본 파일을 읽지 못했습니다: ' + e.message;
      }
      return item;
    });
}

/** 확인 대기에서 빼기 (원본 파일은 드라이브에 그대로 둔다) */
function api_cancelUpload(uploadId) {
  return withLock_(() => {
    const r = readObjects_('uploads').find((x) => x.업로드ID === uploadId);
    if (!r) throw new Error('업로드 기록을 찾지 못했습니다.');
    r.상태 = '취소';
    r.마지막처리일시 = now_();
    writeObject_('uploads', r._row, r);
    return true;
  });
}

/** 기록ID 목록 → 이미 저장된 기록 요약 */
function api_lookup(keys) {
  const want = {};
  keys.forEach((k) => (want[k] = true));
  const out = {};
  readObjects_('records').forEach((r) => {
    if (!want[r.기록ID]) return;
    const o = {};
    CSV_HEADERS.forEach((h) => (o[h] = r[h]));
    o.업로드ID = r.업로드ID;
    o.저장일시 = r.저장일시;
    o.수정일시 = r.수정일시;
    out[r.기록ID] = o;
  });
  return out;
}

/**
 * 확인한 카드 저장
 * p: {
 *   cards: [{ uploadId, rowNo, key, label, values, overwrite, edited: [칸], warnings: [문장] }],
 *   skips: [{ uploadId, rowNo, label, reason }],
 * }
 * → { cards: [{ uploadId, rowNo, status: 'saved'|'overwritten'|'failed', error }], skips: [...], logs: [{ uploadId, ok, error, remaining, status }] }
 */
function api_save(p) {
  return withLock_(() => {
    const time = now_();
    const results = [];
    const records = readObjects_('records');
    const byKey = {};
    records.forEach((r) => (byKey[r.기록ID] = r));

    const fresh = [];
    p.cards.forEach((c) => {
      const res = { uploadId: c.uploadId, rowNo: c.rowNo, key: c.key, label: c.label, status: '', error: '' };
      results.push(res);
      const v = c.values;
      const key = `${v.수업일}_${v.학생번호}`;
      if (key !== c.key) {
        res.status = 'failed';
        res.error = '기록ID가 맞지 않습니다. 화면을 새로 고친 뒤 다시 저장해 주세요.';
        return;
      }
      const obj = {};
      CSV_HEADERS.forEach((h) => (obj[h] = v[h] == null ? '' : v[h]));
      const hasReview = String(v.확인필요 || '').trim() !== '';
      Object.assign(obj, {
        기록ID: key,
        확인필요상태: hasReview ? '해결' : '없음',
        해결일시: hasReview ? time : '',
        수정한칸: (c.edited || []).join('; '),
        검사메모: (c.warnings || []).join(' / '),
        업로드ID: c.uploadId,
        원본파일명: c.fileName || '',
        저장일시: time,
        수정일시: '',
      });
      const old = byKey[key];
      if (old) {
        if (!c.overwrite) {
          res.status = 'failed';
          res.error = '그사이 같은 학생·같은 날짜 기록이 저장됐습니다. 새로 고친 뒤 덮어쓸지 다시 골라 주세요.';
          return;
        }
        obj.저장일시 = old.저장일시 || time;
        obj.수정일시 = time;
        try {
          writeObject_('records', old._row, obj);
          res.status = 'overwritten';
        } catch (e) {
          res.status = 'failed';
          res.error = e.message;
        }
      } else {
        byKey[key] = obj; // 같은 요청 안의 중복 방지
        fresh.push({ obj, res });
      }
    });

    if (fresh.length) {
      try {
        appendObjects_('records', fresh.map((x) => x.obj));
        fresh.forEach((x) => (x.res.status = 'saved'));
      } catch (e) {
        // 한꺼번에 실패하면 한 장씩 다시 시도해서 어느 카드가 안 됐는지 가린다
        fresh.forEach((x) => {
          try {
            appendObjects_('records', [x.obj]);
            x.res.status = 'saved';
          } catch (e2) {
            x.res.status = 'failed';
            x.res.error = e2.message;
          }
        });
      }
    }

    // 업로드이력 갱신
    const logs = [];
    const ids = {};
    results.forEach((r) => (ids[r.uploadId] = true));
    (p.skips || []).forEach((s) => (ids[s.uploadId] = true));
    let uploadRows = [];
    try {
      uploadRows = readObjects_('uploads');
    } catch (e) {
      Object.keys(ids).forEach((id) => logs.push({ uploadId: id, ok: false, error: '업로드이력을 읽지 못했습니다: ' + e.message }));
      return { cards: results, skips: p.skips || [], logs };
    }
    Object.keys(ids).forEach((id) => {
      const log = { uploadId: id, ok: false, error: '' };
      logs.push(log);
      try {
        const r = uploadRows.find((x) => x.업로드ID === id);
        if (!r) throw new Error('업로드 기록을 찾지 못했습니다.');
        const mine = results.filter((x) => x.uploadId === id);
        const skips = (p.skips || []).filter((x) => x.uploadId === id);
        const lines = mine.filter((x) => x.status !== 'failed')
          .map((x) => `${x.rowNo}행(${x.label}) ${x.status === 'overwritten' ? '덮어씀' : '저장'}`)
          .concat(skips.map((x) => `${x.rowNo}행(${x.label}) 건너뜀${x.reason ? '·' + x.reason : ''}`));
        const handled = {};
        (r.처리내역.match(/(\d+)행/g) || []).concat(lines.map((l) => l.match(/^\d+행/)[0])).forEach((s) => (handled[s] = true));
        const cardCount = Number(r.카드수) || 0;
        const remaining = Math.max(0, cardCount - Object.keys(handled).length);
        r.저장 = (Number(r.저장) || 0) + mine.filter((x) => x.status === 'saved').length;
        r.덮어씀 = (Number(r.덮어씀) || 0) + mine.filter((x) => x.status === 'overwritten').length;
        r.건너뜀 = (Number(r.건너뜀) || 0) + skips.length;
        r.남은카드 = remaining;
        r.상태 = remaining === 0 ? '저장 완료' : '일부 저장';
        r.처리내역 = [r.처리내역].concat(lines).filter(Boolean).join('; ');
        r.마지막처리일시 = time;
        const failed = mine.filter((x) => x.status === 'failed');
        r.오류 = failed.length ? failed.map((x) => `${x.rowNo}행 ${x.error}`).join(' / ') : '';
        writeObject_('uploads', r._row, r);
        log.ok = true;
        log.remaining = remaining;
        log.status = r.상태;
      } catch (e) {
        log.error = e.message;
      }
    });
    return { cards: results, skips: p.skips || [], logs };
  });
}

/* ---------- 명단 ---------- */

/** 확인 화면의 [명단에 추가] */
function api_addStudent(s) {
  return withLock_(() => {
    if (!/^\d{2}$/.test(s.no || '') || !s.name) throw new Error('학생번호(두 자리)와 이름이 필요합니다.');
    if (rosterList_().some((r) => r.no === s.no)) throw new Error(`${s.no}번은 이미 명단에 있습니다.`);
    appendObjects_('roster', [{ 학생번호: s.no, 이름: s.name, 학년: s.grade || '', 상태: '재원', 수정일시: now_() }]);
    return rosterList_();
  });
}

/**
 * 명단 불러오기 반영 (디딤돌레벨·발송조·메모는 그대로 둔다)
 * c: { add: [{no,name,grade}], update: [{no,name,grade}], retire: [no] }
 */
function api_applyRoster(c) {
  return withLock_(() => {
    const time = now_();
    const rows = readObjects_('roster');
    (c.update || []).forEach((u) => {
      const r = rows.find((x) => x.학생번호 === u.no);
      if (!r) return;
      Object.assign(r, { 이름: u.name, 학년: u.grade, 상태: '재원', 수정일시: time });
      writeObject_('roster', r._row, r);
    });
    (c.retire || []).forEach((no) => {
      const r = rows.find((x) => x.학생번호 === no);
      if (!r) return;
      Object.assign(r, { 상태: '퇴원', 수정일시: time });
      writeObject_('roster', r._row, r);
    });
    const adds = (c.add || []).filter((a) => !rows.some((x) => x.학생번호 === a.no));
    appendObjects_('roster', adds.map((a) => ({ 학생번호: a.no, 이름: a.name, 학년: a.grade || '', 상태: '재원', 수정일시: time })));
    return rosterList_();
  });
}

/**
 * 학생번호 변경: 학생명단과 그 학생의 수업기록(학생번호·기록ID)을 함께 바꾼다.
 * c: { from, to, dryRun } → { name, count, conflicts: [수업일] }
 *  - 새 번호를 명단에서 누가 쓰고 있으면(퇴원 포함) 바꾸지 않는다 (번호는 다시 쓰지 않음)
 *  - 새 번호로 같은 날짜 기록이 이미 있으면 바꾸지 않고 그 날짜를 알려 준다
 *  - dryRun 이면 바꾸지 않고 몇 건이 바뀔지만 알려 준다
 */
function api_changeNo(c) {
  return withLock_(() => {
    const from = String(c.from || '');
    const to = String(c.to || '').trim();
    if (!/^\d{2}$/.test(to)) throw new Error('새 학생번호는 숫자 두 자리로 입력해 주세요. (예: 07, 57)');
    if (to === from) throw new Error('지금 번호와 같습니다.');
    const roster = readObjects_('roster');
    const me = roster.find((r) => r.학생번호 === from);
    if (!me) throw new Error(`명단에 ${from}번 학생이 없습니다.`);
    const taken = roster.find((r) => r.학생번호 === to);
    if (taken) throw new Error(`${to}번은 이미 ${taken.이름}${taken.상태 === '퇴원' ? '(퇴원)' : ''} 학생이 쓰고 있습니다. 번호는 다시 쓰지 않습니다.`);

    const sh = sheet_('records');
    const values = sh.getDataRange().getDisplayValues();
    const head = values[0] || [];
    const col = (h) => head.indexOf(h);
    const iId = col('기록ID');
    const iNo = col('학생번호');
    const iDate = col('수업일');
    const iUpd = col('수정일시');
    const rows = values.slice(1);
    const keys = {};
    rows.forEach((r) => (keys[r[iId]] = true));
    const mine = rows.filter((r) => r[iNo] === from);
    const conflicts = mine.filter((r) => keys[`${r[iDate]}_${to}`]).map((r) => r[iDate]);
    const out = { name: me.이름, count: mine.length, conflicts };
    if (conflicts.length) {
      throw new Error(`${to}번으로 이미 저장된 기록과 날짜가 겹칩니다: ${conflicts.join(', ')}. 수업기록 탭에서 겹치는 기록을 먼저 정리해 주세요.`);
    }
    if (c.dryRun) return out;

    const time = now_();
    if (rows.length && mine.length) {
      // 기록ID·학생번호·수정일시 세 열만 통째로 다시 쓴다
      rows.forEach((r) => {
        if (r[iNo] !== from) return;
        r[iNo] = to;
        r[iId] = `${r[iDate]}_${to}`;
        r[iUpd] = time;
      });
      [iId, iNo, iUpd].forEach((i) => {
        const range = sh.getRange(2, i + 1, rows.length, 1);
        range.setNumberFormat('@');
        range.setValues(rows.map((r) => [r[i]]));
      });
    }
    const note = `${time.slice(0, 10)} ${from}번에서 ${to}번으로 변경(기록 ${mine.length}건)`;
    Object.assign(me, { 학생번호: to, 메모: [me.메모, note].filter(Boolean).join(' / '), 수정일시: time });
    writeObject_('roster', me._row, me);
    out.roster = rosterList_();
    return out;
  });
}

/**
 * 결제일 관리 앱(Firebase)에서 학생 명단 읽기
 * Firestore 문서 users/{로그인한 사람}/apps/payment 의 json 필드 → { students: [{no,name,grade}], noNumber: [이름] }
 */
function api_fetchPaymentRoster() {
  const projectId = settings_().파이어베이스프로젝트ID || 'jieummath';
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;
  const body = JSON.stringify({ structuredQuery: { from: [{ collectionId: 'apps', allDescendants: true }] } });
  const call = (extra) => UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: body,
    headers: Object.assign({ Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, extra),
    muteHttpExceptions: true,
  });
  // 사용량을 Firebase 프로젝트로 잡아야 통과하는 경우가 있어 먼저 그렇게 시도하고, 안 되면 헤더 없이 다시 시도
  let res = call({ 'X-Goog-User-Project': projectId });
  if (res.getResponseCode() !== 200) {
    const first = res;
    res = call({});
    if (res.getResponseCode() !== 200) {
      throw new Error(`결제일 관리 앱 데이터를 읽지 못했습니다 (${first.getResponseCode()} / ${res.getResponseCode()}). `
        + errorText_(first) + ' / ' + errorText_(res));
    }
  }
  const docs = JSON.parse(res.getContentText())
    .map((x) => x.document)
    .filter((d) => d && /\/apps\/payment$/.test(d.name))
    .sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime)));
  if (!docs.length) throw new Error('Firebase에서 결제일 관리 데이터를 찾지 못했습니다. 결제일 관리 앱에서 구글 로그인(온라인 저장)을 했는지 확인해 주세요.');
  const json = docs[0].fields && docs[0].fields.json && docs[0].fields.json.stringValue;
  const data = JSON.parse(json || '{}');
  const students = (data.students || []).map((s) => ({ no: String(s.no || ''), name: String(s.name || '').trim(), grade: s.grade || '' }));
  return {
    students: students.filter((s) => /^\d{2}$/.test(s.no)),
    noNumber: students.filter((s) => !/^\d{2}$/.test(s.no)).map((s) => s.name),
    updatedAt: docs[0].updateTime,
    accounts: docs.length,
  };
}

function errorText_(res) {
  try {
    return JSON.parse(res.getContentText()).error.message;
  } catch (e) {
    return res.getContentText().slice(0, 200);
  }
}

/* ---------- 트래킹 (2단계) ---------- */

/** 저장된 수업기록 전체 (화면에서 기간·학생별로 나눠 계산한다) */
function api_records() {
  const keep = ['기록ID'].concat(CSV_HEADERS, ['확인필요상태', '수정한칸', '저장일시', '수정일시']);
  return readObjects_('records')
    .filter((r) => r.기록ID)
    .map((r) => {
      const o = {};
      keep.forEach((h) => (o[h] = r[h] == null ? '' : r[h]));
      return o;
    });
}

const LEVELS = ['기본', '기본+유형', '기본+응용'];
const STATUSES = ['재원', '퇴원'];

/**
 * 명단 한 명 추가·수정 (학생번호는 api_changeNo 로만 바꾼다)
 * s: { no, name, grade, level, group, status, memo, isNew }
 */
function api_saveStudent(s) {
  return withLock_(() => {
    const no = String(s.no || '');
    const name = String(s.name || '').trim();
    if (!/^\d{2}$/.test(no)) throw new Error('학생번호는 숫자 두 자리여야 합니다.');
    if (!name) throw new Error('이름을 입력해 주세요.');
    if (s.level && LEVELS.indexOf(s.level) < 0) throw new Error('디딤돌 레벨은 ' + LEVELS.join(' / ') + ' 중 하나여야 합니다.');
    if (s.group && ['A', 'B'].indexOf(s.group) < 0) throw new Error('발송 조는 A 또는 B여야 합니다.');
    const status = s.status || '재원';
    if (STATUSES.indexOf(status) < 0) throw new Error('상태는 재원 또는 퇴원이어야 합니다.');
    const rows = readObjects_('roster');
    const r = rows.find((x) => x.학생번호 === no);
    const obj = { 학생번호: no, 이름: name, 학년: s.grade || '', 디딤돌레벨: s.level || '', 발송조: s.group || '', 상태: status, 메모: s.memo || '', 수정일시: now_() };
    if (s.isNew) {
      if (r) throw new Error(`${no}번은 이미 ${r.이름} 학생이 쓰고 있습니다.`);
      appendObjects_('roster', [obj]);
    } else {
      if (!r) throw new Error(`명단에 ${no}번 학생이 없습니다.`);
      writeObject_('roster', r._row, obj);
    }
    return rosterList_();
  });
}

/**
 * 전체 기록 내보내기 → 드라이브 "진도카드 내보내기" 폴더에 파일을 만들고 링크를 돌려준다
 * kind: 'csv' (수업기록 탭, UTF-8) | 'xlsx' (시트 전체: 학생명단·수업기록·업로드이력·설정)
 */
function api_export(kind) {
  const ss = ss_();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm');
  const it = DriveApp.getFoldersByName(EXPORT_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(EXPORT_FOLDER_NAME);
  let blob;
  if (kind === 'csv') {
    const values = sheet_('records').getDataRange().getDisplayValues();
    const csv = '\uFEFF' + values.map((row) => row.map((v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
    blob = Utilities.newBlob(csv, 'text/csv', `진도카드_수업기록_${stamp}.csv`);
  } else if (kind === 'xlsx') {
    const res = UrlFetchApp.fetch(`https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=xlsx`, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error(`엑셀 파일을 만들지 못했습니다 (${res.getResponseCode()}).`);
    blob = res.getBlob().setName(`진도카드_전체기록_${stamp}.xlsx`);
  } else {
    throw new Error('알 수 없는 형식입니다.');
  }
  const file = folder.createFile(blob);
  return { name: file.getName(), url: file.getUrl(), folderUrl: folder.getUrl() };
}

/* ---------- 설정 ---------- */

function api_saveSetting(name, value) {
  const allowed = ['두고옴처리', '파이어베이스프로젝트ID'];
  if (allowed.indexOf(name) < 0) throw new Error('바꿀 수 없는 설정입니다.');
  if (name === '두고옴처리' && DONE_OPTIONS.indexOf(value) < 0) throw new Error('알 수 없는 값입니다.');
  setSetting_(name, value);
  return settings_();
}
