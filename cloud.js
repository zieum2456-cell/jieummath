/*
 * 구글 로그인 + 온라인 저장(Firebase) 연결
 *
 * - firebase-config.js에 설정값이 없으면 아무것도 하지 않는다 (지금처럼 이 브라우저에만 저장).
 * - 로그인하면 데이터를 Firestore의 users/{로그인한 사람}/apps/{key} 문서 하나에 JSON 문자열로 저장하고,
 *   다른 기기에서 바뀌면 바로 받아온다.
 * - localStorage는 계속 함께 쓴다 (빠른 시작, 오프라인 대비).
 *
 * 앱에서 쓰는 법:
 *   Cloud.attach({ key, label, storeKey, mount, getState, applyRemote })
 *   Cloud.push()   // 앱이 저장할 때마다 호출
 *   Cloud.watch(key, cb)   // 다른 앱의 데이터를 읽기만 할 때 (예: 시간표가 결제일 관리의 학년을 가져옴)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cloud = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

  /*
   * 로그인 직후 이 브라우저 데이터와 온라인 데이터 중 무엇을 쓸지 정한다.
   *   local, cloud: JSON 문자열 또는 null
   *   dirty: 로그인 상태에서 고쳤는데 아직 온라인에 저장되지 못한 내용이 있음 (오프라인 등)
   *   linked: 이 브라우저가 이미 같은 계정으로 연결된 적 있음
   *   cloudChanged: 이 브라우저가 마지막으로 맞춘 뒤 다른 기기에서 온라인 데이터가 바뀜
   * 결과: 'none' | 'upload' | 'download' | 'ask'
   */
  function decide({ local, cloud, dirty, linked, cloudChanged }) {
    if (cloud == null) return local == null ? 'none' : 'upload';
    if (local == null || local === cloud) return 'download';
    if (linked) {
      if (!dirty) return 'download';
      // 못 올린 변경이 있어도, 그사이 다른 기기에서 바뀌었으면 몰래 덮어쓰지 않고 물어본다
      return cloudChanged ? 'ask' : 'upload';
    }
    return 'ask'; // 처음 연결하는 브라우저에 다른 데이터가 있음
  }

  // 온라인 데이터가 바뀌었는지 비교하려고 남겨 두는 짧은 지문
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return str.length.toString(36) + '.' + h.toString(36);
  }

  function countText(json) {
    try {
      const data = JSON.parse(json);
      const n = (data.students || []).length;
      const w = (data.waitlist || []).length;
      return `학생 ${n}명` + (w ? `, 대기 ${w}명` : '');
    } catch (e) {
      return '데이터';
    }
  }

  function downloadJson(json, filename) {
    const blob = new Blob([JSON.stringify(JSON.parse(json), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let opts = null;
  let fb = null; // 불러온 Firebase 함수들
  let auth = null;
  let db = null;
  let user = null;
  let ref = null;
  let unsubscribe = null;
  let lastJson = null; // 온라인과 맞춰 둔 마지막 내용
  let timer = null;
  let ready = false; // 로그인 직후 첫 맞추기가 끝났는지
  let status = 'off';
  let syncedAt = null; // 온라인과 마지막으로 맞춘 시각
  const watchers = []; // { key, cb, stop }

  const flagKey = (name) => `${opts.storeKey}-cloud-${name}`;
  const getFlag = (name) => { try { return localStorage.getItem(flagKey(name)); } catch (e) { return null; } };
  const setFlag = (name, v) => {
    try {
      if (v == null) localStorage.removeItem(flagKey(name));
      else localStorage.setItem(flagKey(name), v);
    } catch (e) { /* 저장 공간 문제는 앱 쪽 save()에서 알림 */ }
  };

  function setStatus(s) {
    status = s;
    if (s === 'saved') syncedAt = new Date();
    render();
  }

  // 온라인과 맞춘 내용을 기억해 둔다 (다음에 열 때 다른 기기에서 바뀌었는지 알 수 있게)
  function markSynced(json) {
    lastJson = json;
    setFlag('base', json == null ? null : hash(json));
  }

  function render() {
    const el = opts && opts.mount;
    if (!el) return;
    if (!fb) {
      el.innerHTML = status === 'error-load'
        ? '<span class="cloud-status err" title="인터넷 연결을 확인해 주세요">온라인 저장 연결 실패</span>'
        : '';
      return;
    }
    if (!user) {
      el.innerHTML = '<button class="btn small" data-cloud="login">구글 로그인 (온라인 저장)</button>';
      return;
    }
    const time = syncedAt
      ? ` ${String(syncedAt.getHours()).padStart(2, '0')}:${String(syncedAt.getMinutes()).padStart(2, '0')}`
      : '';
    const text = {
      syncing: '불러오는 중…',
      saving: '저장 중…',
      saved: '온라인 저장됨' + time,
      offline: '오프라인 · 연결되면 저장',
      error: '온라인 저장 실패',
    }[status] || '';
    const who = String(user.email || '').split('@')[0];
    el.innerHTML = `<span class="cloud-status ${status === 'error' ? 'err' : ''}" title="${esc(user.email)}">${text}${who ? ` · ${esc(who)}` : ''}</span>`
      + `<button class="btn small" data-cloud="logout" title="${esc(user.email)}">로그아웃</button>`;
  }

  async function loadSdk() {
    const [app, authMod, fs] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js'),
    ]);
    return { ...app, ...authMod, ...fs };
  }

  async function attach(o) {
    opts = o;
    const config = typeof window !== 'undefined' && window.FIREBASE_CONFIG;
    if (!config || !config.apiKey) return; // 설정 전: 이 브라우저에만 저장
    if (opts.mount) {
      opts.mount.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-cloud]');
        if (b && b.dataset.cloud === 'login') login();
        if (b && b.dataset.cloud === 'logout') logout();
      });
    }
    try {
      fb = await loadSdk();
    } catch (e) {
      console.error(e);
      setStatus('error-load');
      return;
    }
    const app = fb.initializeApp(config);
    auth = fb.getAuth(app);
    db = fb.getFirestore(app);
    window.addEventListener('online', () => { if (user && status === 'offline') flush(); });
    // 휴대폰은 뒤로 보낸 탭을 다시 켤 때 예전 화면을 그대로 보여 주므로,
    // 화면을 떠날 때는 남은 변경을 바로 올리고, 돌아오면 온라인 최신본을 다시 받아온다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      else refresh();
    });
    window.addEventListener('pagehide', () => { flush(); });
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) refresh(); });
    fb.getRedirectResult(auth).catch(loginError);
    fb.onAuthStateChanged(auth, (u) => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      watchers.forEach(stopWatcher);
      user = u;
      ready = false;
      lastJson = null;
      if (!u) return setStatus('off');
      connect();
      watchers.forEach(startWatcher);
    });
    render();
  }

  function loginError(e) {
    if (!e) return;
    console.error(e);
    if (e.code === 'auth/unauthorized-domain') {
      alert(`이 주소(${location.hostname || '내 컴퓨터 파일'})에서는 로그인할 수 없습니다.\n`
        + 'GitHub Pages 주소로 열거나, Firebase 콘솔 > Authentication > 설정 > 승인된 도메인에 이 주소를 추가해 주세요.');
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      alert('로그인에 실패했습니다.\n' + (e.message || e.code));
    }
  }

  /*
   * 카카오톡·네이버 등 앱 안의 브라우저(웹뷰)는 구글 로그인을 막고,
   * 로그인 창(firebaseapp.com)이 저장소를 못 써서 'Unable to save initial state' 오류가 난다.
   * 이런 경우에는 Chrome/Safari로 다시 열도록 안내한다.
   */
  function inAppBrowser(ua) {
    return /KAKAOTALK|NAVER\(inapp|DaumApps|Instagram|FBAN|FBAV|Line\/|everytimeApp|; wv\)/i.test(ua || '');
  }

  function openInExternalBrowser() {
    const ua = navigator.userAgent;
    const url = location.href;
    if (/KAKAOTALK/i.test(ua)) {
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url);
      return;
    }
    if (/Android/i.test(ua)) {
      location.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
      return;
    }
    alert('앱 안의 브라우저에서는 구글 로그인을 할 수 없습니다.\n'
      + '화면 오른쪽 위(또는 아래) 메뉴에서 [Safari로 열기] 또는 [다른 브라우저로 열기]를 눌러 주세요.');
  }

  async function login() {
    if (inAppBrowser(navigator.userAgent)) {
      if (confirm('앱 안의 브라우저에서는 구글 로그인이 되지 않습니다.\nChrome(또는 Safari)에서 열까요?')) openInExternalBrowser();
      return;
    }
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await fb.signInWithPopup(auth, provider);
    } catch (e) {
      // 페이지 이동(redirect) 방식은 GitHub Pages ↔ firebaseapp.com 처럼 주소가 다르면
      // 최신 브라우저에서 'Unable to save initial state' 오류가 나므로 쓰지 않는다.
      if (e.code === 'auth/popup-blocked') {
        alert('팝업이 차단되어 로그인 창을 열 수 없습니다.\n주소창 오른쪽의 팝업 차단 표시를 눌러 이 사이트의 팝업을 허용한 뒤 다시 로그인해 주세요.');
        return;
      }
      loginError(e);
    }
  }

  async function logout() {
    if (!confirm('로그아웃할까요?')) return;
    await Promise.race([flush(), new Promise((r) => setTimeout(r, 3000))]);
    const unsaved = getFlag('dirty') === '1';
    if (unsaved && !confirm('아직 온라인에 저장되지 않은 변경이 있습니다(인터넷 연결 확인).\n그래도 로그아웃할까요?')) return;
    const wipe = !unsaved && confirm('이 컴퓨터(브라우저)에 남아 있는 데이터도 지울까요?\n'
      + '공용 컴퓨터라면 [확인]을 눌러 지우세요. 데이터는 온라인에 그대로 남아 있어 다시 로그인하면 불러옵니다.');
    await fb.signOut(auth);
    setFlag('uid', null);
    setFlag('dirty', null);
    if (wipe) {
      try { localStorage.removeItem(opts.storeKey); } catch (e) { /* 무시 */ }
      location.reload();
    }
  }

  function connect() {
    const uid = user.uid;
    ref = fb.doc(db, 'users', uid, 'apps', opts.key);
    setStatus('syncing');
    unsubscribe = fb.onSnapshot(ref, { includeMetadataChanges: false }, (snap) => {
      if (!user || user.uid !== uid) return;
      const cloud = snap.exists() ? snap.data().json : null;
      if (!ready) return reconcile(cloud);
      if (snap.metadata.hasPendingWrites || timer) return; // 내가 보낸 것 / 곧 보낼 것이 있음
      if (cloud != null && cloud !== lastJson) {
        markSynced(cloud);
        opts.applyRemote(JSON.parse(cloud));
        setStatus('saved');
      }
    }, (e) => {
      console.error(e);
      setStatus('error');
      if (e.code === 'permission-denied') alert('온라인 데이터를 읽을 권한이 없습니다. Firestore 보안 규칙을 확인해 주세요.');
    });
  }

  // 로그인 직후, 그리고 화면으로 돌아올 때마다 이 브라우저와 온라인 데이터를 맞춘다
  function reconcile(cloud) {
    const local = JSON.stringify(opts.getState());
    const hasLocal = (() => {
      try { return localStorage.getItem(opts.storeKey) != null; } catch (e) { return false; }
    })();
    const linked = getFlag('uid') === user.uid;
    const base = getFlag('base');
    const action = decide({
      local: hasLocal ? local : null,
      cloud,
      dirty: getFlag('dirty') === '1',
      linked,
      cloudChanged: cloud != null && (!base || base !== hash(cloud)),
    });
    let use = action;
    if (action === 'ask') {
      const ok = confirm((linked
        ? `다른 기기에서 ${opts.label} 데이터(${countText(cloud)})가 바뀌었는데,\n`
          + `이 브라우저에도 아직 온라인에 올리지 못한 변경(${countText(local)})이 있습니다.\n\n`
        : `온라인에 저장된 ${opts.label} 데이터(${countText(cloud)})가 있습니다.\n`
          + `이 브라우저에도 다른 데이터(${countText(local)})가 있습니다.\n\n`)
        + '[확인] 온라인 데이터를 사용합니다. 이 브라우저 데이터는 백업 파일로 내려받아 둡니다.\n'
        + '[취소] 이 브라우저 데이터로 온라인 데이터를 덮어씁니다.');
      if (ok) {
        downloadJson(local, `${opts.label}-이전-브라우저-데이터.json`);
        use = 'download';
      } else {
        use = 'upload';
      }
    }
    setFlag('uid', user.uid);
    ready = true;
    if (use === 'download') {
      markSynced(cloud);
      setFlag('dirty', null);
      if (cloud !== local) opts.applyRemote(JSON.parse(cloud));
      setStatus('saved');
    } else if (use === 'upload') {
      lastJson = cloud;
      push(true);
    } else {
      markSynced(cloud);
      setStatus('saved');
    }
  }

  // 화면으로 돌아왔을 때: 열어 둔 사이 다른 기기에서 바뀐 내용을 서버에서 직접 받아온다
  let refreshing = false;
  async function refresh() {
    if (!user || !ready || !ref || refreshing) return;
    if (timer) return flush();
    refreshing = true;
    const uid = user.uid;
    try {
      const snap = await fb.getDocFromServer(ref);
      if (!user || user.uid !== uid || timer) return;
      reconcile(snap.exists() ? snap.data().json : null);
    } catch (e) {
      console.error(e); // 오프라인 등: 연결되면 실시간 구독이 이어서 받아온다
    } finally {
      refreshing = false;
    }
  }

  // 다른 앱 데이터 읽기 전용 구독 (로그인하면 시작, 로그아웃하면 멈춤)
  function startWatcher(w) {
    stopWatcher(w);
    if (!fb || !user) return;
    w.stop = fb.onSnapshot(fb.doc(db, 'users', user.uid, 'apps', w.key), (snap) => {
      if (!snap.exists()) return;
      try {
        w.cb(JSON.parse(snap.data().json));
      } catch (e) {
        console.error(e);
      }
    }, (e) => console.error(e));
  }

  function stopWatcher(w) {
    if (w.stop) w.stop();
    w.stop = null;
  }

  function watch(key, cb) {
    const w = { key, cb, stop: null };
    watchers.push(w);
    startWatcher(w);
  }

  // 앱이 저장할 때마다 호출. 잠깐 모았다가 한 번에 올린다
  function push(now) {
    if (!user || !ready) return;
    const json = JSON.stringify(opts.getState());
    if (json === lastJson) return;
    setFlag('dirty', '1');
    setStatus(navigator.onLine === false ? 'offline' : 'saving');
    clearTimeout(timer);
    timer = setTimeout(flush, now === true ? 0 : 800);
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!user || !ready) return;
    const json = JSON.stringify(opts.getState());
    if (json === lastJson && getFlag('dirty') !== '1') return;
    lastJson = json;
    try {
      await fb.setDoc(ref, { json, updatedAt: fb.serverTimestamp() });
      setFlag('base', hash(json));
      if (JSON.stringify(opts.getState()) === json) {
        setFlag('dirty', null);
        setStatus('saved');
      }
    } catch (e) {
      console.error(e);
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  }

  return { decide, hash, inAppBrowser, attach, push, flush, watch };
});
