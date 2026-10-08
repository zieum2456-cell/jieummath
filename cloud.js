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
   * 결과: 'none' | 'upload' | 'download' | 'ask'
   */
  function decide({ local, cloud, dirty, linked }) {
    if (cloud == null) return local == null ? 'none' : 'upload';
    if (local == null || local === cloud) return 'download';
    if (linked) return dirty ? 'upload' : 'download';
    return 'ask'; // 처음 연결하는 브라우저에 다른 데이터가 있음
  }

  function countText(json) {
    try {
      const n = (JSON.parse(json).students || []).length;
      return `학생 ${n}명`;
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
    render();
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
    const text = {
      syncing: '불러오는 중…',
      saving: '저장 중…',
      saved: '온라인 저장됨',
      offline: '오프라인 · 연결되면 저장',
      error: '온라인 저장 실패',
    }[status] || '';
    el.innerHTML = `<span class="cloud-status ${status === 'error' ? 'err' : ''}" title="${esc(user.email)}">${text}</span>`
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
    fb.getRedirectResult(auth).catch(loginError);
    fb.onAuthStateChanged(auth, (u) => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      user = u;
      ready = false;
      lastJson = null;
      if (!u) return setStatus('off');
      connect();
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

  async function login() {
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await fb.signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === 'auth/popup-blocked') return fb.signInWithRedirect(auth, provider).catch(loginError);
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
      if (!ready) return firstSync(cloud);
      if (snap.metadata.hasPendingWrites || timer) return; // 내가 보낸 것 / 곧 보낼 것이 있음
      if (cloud != null && cloud !== lastJson) {
        lastJson = cloud;
        opts.applyRemote(JSON.parse(cloud));
      }
    }, (e) => {
      console.error(e);
      setStatus('error');
      if (e.code === 'permission-denied') alert('온라인 데이터를 읽을 권한이 없습니다. Firestore 보안 규칙을 확인해 주세요.');
    });
  }

  function firstSync(cloud) {
    const local = JSON.stringify(opts.getState());
    const hasLocal = (() => {
      try { return localStorage.getItem(opts.storeKey) != null; } catch (e) { return false; }
    })();
    const action = decide({
      local: hasLocal ? local : null,
      cloud,
      dirty: getFlag('dirty') === '1',
      linked: getFlag('uid') === user.uid,
    });
    let use = action;
    if (action === 'ask') {
      const ok = confirm(`온라인에 저장된 ${opts.label} 데이터(${countText(cloud)})가 있습니다.\n`
        + `이 브라우저에도 다른 데이터(${countText(local)})가 있습니다.\n\n`
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
      lastJson = cloud;
      setFlag('dirty', null);
      opts.applyRemote(JSON.parse(cloud));
      setStatus('saved');
    } else if (use === 'upload') {
      lastJson = cloud;
      push(true);
    } else {
      lastJson = cloud;
      setStatus('saved');
    }
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
      if (JSON.stringify(opts.getState()) === json) {
        setFlag('dirty', null);
        setStatus('saved');
      }
    } catch (e) {
      console.error(e);
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  }

  return { decide, attach, push, flush };
});
