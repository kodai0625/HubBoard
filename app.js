'use strict';
// Hub Board スマホ版（設計.md「段階5」）。同じ画面を2つの形で使う。
//
//   Mac が配る画面（http://Mac:8140/?t=合言葉） … いつも Mac に聞く
//   iPhone アプリ（GitHub Pages。URL の #p= につなぐ先・合言葉・鍵） …
//     Mac が起きていれば Tailscale の https で Mac に直接、切れていれば預かり口（relay.js）
//
// ★つなぐ先と合言葉は URL から受け取り、この端末に覚える。ホーム画面に追加した Hub Board は
//   Safari と保存場所が別なので、URL に残したままにしておく（追加するときの URL ごと覚えさせるため）
// ★#p= の後ろ（鍵を含む）は、どこのサーバーにも送られない。?t= は Mac にだけ届く
// ★この画面に残すのは、合言葉・つなぐ先・選んだプロジェクトと、暗号のままの写し・控えだけ

const $ = (s, root) => (root || document).querySelector(s);

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 覚えられなくても動く */ } },
};

/** iPhone アプリのつなぐ先（#p=）。無ければ、前に覚えたもの */
function readConfig() {
  const m = location.hash.match(/[#&]p=([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const c = JSON.parse(new TextDecoder().decode(b64ToBytes(m[1])));
      if (c && c.t) { store.set('hub-config', JSON.stringify(c)); return c; }
    } catch (e) { /* 形が違えば使わない */ }
  }
  try { return JSON.parse(store.get('hub-config') || 'null'); } catch (e) { return null; }
}

const CFG = location.protocol === 'https:' || /[#&]p=/.test(location.hash) || store.get('hub-config') ? readConfig() : null;
const APP = !!CFG;                               // iPhone アプリとして動いているか
const BASE = APP ? (CFG.m || '') : '';           // Mac の場所（iPhone アプリのとき）

let token = APP ? CFG.t : (new URLSearchParams(location.search).get('t') || '');
if (!APP) { if (token) store.set('hub-token', token); else token = store.get('hub-token'); }

const S = {
  state: null,
  project: store.get('hub-project'),   // '' = すべて
  open: null,                          // 開いているタスクの ID
  tab: 'chat',
  task: null,
  entries: [],
  total: 0,
  memoTime: null,
  memoDirty: false,
  busy: false,
  timer: 0,
  okAt: 0,
  sig: '',                             // 前に描いた一覧の中身（同じなら描き直さない）
  stopped: false,                      // 合言葉が違うと言われたら、聞くのをやめる
  pushed: false,                       // 開いたときに履歴を足したか（戻るで履歴を戻すか）
  mode: 'direct',                      // direct＝Mac に直接、relay＝預かり口（Mac が切れているとき）
  probeAt: 0,                          // 預かり口のとき、最後に Mac を試した時刻
  relayAt: 0,                          // 最後に預かり口の写しを読んだ時刻
  chatSig: '',                         // 預かり口のとき、前に描いた会話の中身
  inboxOpen: false,                    // 「あなた待ち」を開いているか
  inboxSig: '',                        // 前に描いたあなた待ち（同じなら描き直さない。書きかけを消さないため）
  inboxPushed: false,
};

// ---------- Mac とのやり取り ----------

/** Mac に直接か、預かり口か。Mac につながらないときは預かり口に切り替える（読むときだけ。送るのは2回にしない） */
async function api(path, body) {
  if (S.mode === 'relay') return Relay.api(path, body);
  try {
    return await direct(path, body);
  } catch (e) {
    if (e.network && APP && Relay.ready()) {
      await toRelay();
      if (!body) return Relay.api(path, body);
      throw new Error('Mac につながらなかったので、送っていません。もう一度押すと預けます');
    }
    throw e;
  }
}

async function direct(path, body, wait) {
  if (APP && !BASE) {
    const e = new Error('Mac に直接つなぐ道がありません');
    e.network = true;
    throw e;
  }
  const opt = { method: body ? 'POST' : 'GET', headers: { 'X-Hub-Token': token }, cache: 'no-store' };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), wait || (APP && !body ? 6000 : 12000));
  opt.signal = ctl.signal;
  let res;
  try {
    res = await fetch(BASE + path, opt);
  } catch (e) {
    setConn(false);
    const err = new Error('Mac につながりません（外では iPhone の Tailscale がつながっているか確かめてください）');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(tm);
  }
  setConn(true);
  let j = null;
  try { j = await res.json(); } catch (e) { /* 下で知らせる */ }
  if (res.status === 401 || res.status === 429) {
    S.stopped = true;
    showPair((j && j.error) || '合言葉が違います。');
  }
  if (!res.ok || !j || j.ok === false) {
    const err = new Error((j && j.error) || ('うまくいきませんでした（' + res.status + '）'));
    err.status = res.status;
    err.data = j;
    throw err;
  }
  return j;
}

function setConn(ok) {
  const el = $('#conn');
  if (ok) S.okAt = Date.now();
  el.textContent = ok || S.mode === 'relay' ? '' : 'Mac につながりません';
  el.classList.toggle('is-bad', !ok);
  if (!ok) renderFoot();
}

function showPair(text) {
  $('#pairText').textContent = text;
  $('#pair').hidden = false;
}

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- Mac に直接 ⇄ 預かり口 ----------

/** Mac に直接つながるか（数秒で見切る） */
async function probeMac() {
  if (!BASE) return false;
  try { await direct('/api/state', null, 4000); return true; } catch (e) { return false; }
}

async function toRelay() {
  if (S.mode === 'relay') return;
  S.mode = 'relay';
  S.probeAt = Date.now();
  resetDetail();
  try { showFinished(await Relay.refresh()); } catch (e) { /* 電波が無ければ、前に読んだ写しで見せる */ }
  S.relayAt = Date.now();
  S.sig = '';
  $('#conn').textContent = '';                 // 帯に出すので、上の「つながりません」は消す
  $('#conn').classList.remove('is-bad');
  renderRelayBar();
}

function toDirect() {
  if (S.mode === 'direct') return;
  S.mode = 'direct';
  resetDetail();
  S.sig = '';
  renderRelayBar();
  toast('Mac につながりました');
}

/** 道が変わったら、開いているタスクを読み直す */
function resetDetail() {
  S.inboxSig = '';
  S.task = null;
  S.entries = [];
  S.total = 0;
  S.memoTime = null;
  S.chatSig = '';
  if (!S.memoDirty) setMemoNote('');
}

function renderRelayBar() {
  document.querySelectorAll('[data-relaybar]').forEach((el) => {
    el.hidden = S.mode !== 'relay';
    if (S.mode !== 'relay') return;
    const at = Relay.snapAt ? hm(new Date(Relay.snapAt)) + ' の様子です。' : '';
    const n = Relay.pending.length;
    el.textContent = 'Mac が切れています。' + at + '頼みは預かって、Mac が起きたら動きます'
      + (n ? '（預けている頼み ' + n + '件）' : '');
  });
}

/** Mac が動かした預けた頼みを知らせる */
function showFinished(list) {
  if (!list || !list.length) return;
  const bad = list.filter((p) => p.result && !p.result.ok);
  toast(bad.length
    ? '預けた頼みのうち ' + bad.length + '件は動かせませんでした：' + bad.map((p) => p.result.note).join('／')
    : 'Mac が預けた頼みを受け取りました（' + list.length + '件）');
  renderRelayBar();
}

// ---------- 定期的に聞く ----------

function schedule(ms) {
  clearTimeout(S.timer);
  S.timer = setTimeout(tick, ms);
}

async function tick() {
  if (document.hidden || !token || S.stopped) return;
  const now = Date.now();
  if (S.mode === 'relay') {
    // Mac に戻れるか（20秒に1回）、写しが新しくなったか（15秒に1回）
    if (BASE && now - S.probeAt > 20000) {
      S.probeAt = now;
      if (await probeMac()) toDirect();
    }
    if (S.mode === 'relay' && now - S.relayAt > 15000) {
      S.relayAt = now;
      try { showFinished(await Relay.refresh()); S.sig = ''; } catch (e) { /* 前の写しのまま */ }
      renderRelayBar();
    }
  } else if (Relay.ready() && Relay.pending.length && now - S.relayAt > 30000) {
    // Mac につながっていても、預けた頼みが済んだかは写しで分かる
    S.relayAt = now;
    Relay.refresh().then(showFinished).catch(() => {});
  }
  try {
    if (S.open) await loadTask(); else await loadState();
  } catch (e) { /* つながらないときは上に出ている */ }
  const fast = S.mode === 'direct' && (S.open ? !!(S.task && S.task.working) : !!(S.state && S.state.working));
  schedule(S.mode === 'relay' ? 5000 : fast ? 1500 : 3000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

// ---------- 一覧 ----------

async function loadState() {
  const st = await api('/api/state');
  S.state = st;
  const sig = JSON.stringify(st) + '|' + S.project + '|' + today();
  if (sig === S.sig) { renderFoot(); return; }
  S.sig = sig;
  renderList();
}

function projectOf(id) {
  return (S.state && S.state.projects.find((p) => p.id === id)) || null;
}

function renderList() {
  const st = S.state;
  if (!st) return;
  if (S.project && !projectOf(S.project)) S.project = '';

  // プロジェクト
  const nav = $('#projects');
  nav.textContent = '';
  const all = st.sections.flatMap((s) => s.tasks).filter((t) => !t.done);
  const chip = (id, name, color, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (S.project === id ? ' on' : '');
    if (color) {
      const d = document.createElement('span');
      d.className = 'pdot';
      d.style.background = color;
      b.append(d);
    }
    b.append(name);
    const c = document.createElement('span');
    c.className = 'chip__n';
    c.textContent = String(n);
    b.append(c);
    b.addEventListener('click', () => {
      S.project = id;
      store.set('hub-project', id);
      S.sig = '';
      renderList();
    });
    nav.append(b);
  };
  chip('', 'すべて', '', all.length);
  st.projects.forEach((p) => chip(p.id, p.name, p.color, all.filter((t) => t.project === p.id).length));

  // あなた待ち
  const ib = st.inbox || [];
  $('#inboxCard').hidden = false;
  $('#inboxCount').textContent = ib.length ? ib.length + '件' : 'なし';
  $('#inboxCard').classList.toggle('is-empty', !ib.length);
  if (S.inboxOpen) renderInbox();

  // Vice
  const v = st.vice;
  if (v) {
    $('#viceSub').textContent = v.working ? v.working
      : (v.lastLine || '何でも書いて送ると、タスクにして担当の AI に回します');
    $('#viceDot').hidden = !v.unread;
  }

  // 見出しごと
  const box = $('#sections');
  box.textContent = '';
  let shown = 0;
  st.sections.forEach((sec) => {
    const tasks = sec.tasks.filter((t) => !S.project || t.project === S.project);
    if (!tasks.length) return;
    shown += tasks.length;
    const h = document.createElement('div');
    h.className = 'sec__title';
    h.textContent = sec.title;
    const list = document.createElement('div');
    list.className = 'sec__list';
    tasks.forEach((t) => list.append(row(t)));
    box.append(h, list);
  });
  $('#empty').hidden = shown > 0;
  renderFoot();
}

function row(t) {
  const r = document.createElement('div');
  r.className = 'row' + (t.done ? ' is-done' : '');

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('aria-label', t.done ? 'おわっていないに戻す' : 'おわった');
  check.addEventListener('click', () => toggleDone(t.id));

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row__main';
  const title = document.createElement('div');
  title.className = 'row__t';
  title.textContent = t.title;
  const sub = document.createElement('div');
  sub.className = 'row__s';
  const p = projectOf(t.project);
  if (p) {
    const d = document.createElement('span');
    d.className = 'pdot';
    d.style.background = p.color;
    sub.append(d);
    if (!S.project) {
      const n = document.createElement('span');
      n.className = 'pname';
      n.textContent = p.name;
      sub.append(n);
    }
  }
  if (t.due && !t.done) {
    const d = document.createElement('span');
    d.className = 'due' + (t.due < today() ? ' is-late' : '');
    d.textContent = dueText(t.due);
    sub.append(d);
  }
  const bits = [];
  if (t.mail) bits.push('✉︎');
  if (t.parent) bits.push('← ' + t.parent);
  const txt = document.createElement('span');
  txt.className = 'txt' + (t.working ? ' is-working' : '');
  txt.textContent = t.working ? ('⚙︎ ' + t.working) : bits.concat(t.lastLine ? [t.lastLine] : []).join('　');
  sub.append(txt);
  main.append(title);
  if (sub.childNodes.length && (p || t.due || txt.textContent)) main.append(sub);
  if (t.kind === 'pending') {
    main.addEventListener('click', () => toast('Mac が起きたら足します'));
    check.disabled = true;
  } else {
    main.addEventListener('click', () => openTask(t.id));
  }

  r.append(check, main);
  if (t.unread) {
    const u = document.createElement('span');
    u.className = 'dot-unread';
    u.setAttribute('aria-label', '未読');
    r.append(u);
  }
  return r;
}

function renderFoot() {
  const f = $('#foot');
  f.textContent = '';
  const st = S.state;
  const add = (text, cls) => {
    const s = document.createElement('span');
    s.textContent = text;
    if (cls) s.className = cls;
    f.append(s);
  };
  if (!st) { add(S.mode === 'relay' ? '預かり口に聞いています…' : 'Mac に聞いています…'); return; }
  const u = st.usage || {};
  const w = (label, x) => {
    if (!x) return add(label + ' —');
    add(label + ' ' + x.pct + '%', x.pct >= 80 ? 'is-warn' : '');
  };
  w('5時間', u.fiveHour);
  w('1週間', u.sevenDay);
  if (st.working) add('AI 作業中 ' + st.working + '件');
  if (st.claude) add(st.claude, 'is-bad');
  if (S.mode === 'direct' && S.okAt && Date.now() - S.okAt > 15000) {
    add('Mac につながりません。Mac が起きていて Hub Board が開いているか、外では iPhone の Tailscale がつながっているかを確かめてください', 'is-bad');
  }
}

async function toggleDone(id) {
  try {
    const r = await api('/api/task/' + id + '/done', {});
    if (r.queued) { toast('預けました。Mac が起きたら、おわりにします'); renderRelayBar(); S.sig = ''; }
    if (S.open) await loadTask(); else await loadState();
  } catch (e) { toast(e.message); }
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addInput');
  const title = input.value.trim();
  if (!title) return;
  input.disabled = true;
  try {
    const r = await api('/api/task', { title, project: S.project || null });
    input.value = '';
    if (r.queued) { toast('預けました。Mac が起きたら足します'); renderRelayBar(); S.sig = ''; }
    await loadState();
  } catch (err) {
    toast(err.message);
  } finally {
    input.disabled = false;
  }
});

// ---------- あなた待ち ----------

$('#inboxCard').addEventListener('click', () => openInboxView());
$('#inboxBack').addEventListener('click', () => {
  if (S.inboxPushed) { history.back(); return; }
  closeInboxView();
});

function openInboxView(fromHistory) {
  S.inboxOpen = true;
  S.inboxSig = '';
  $('#list').hidden = true;
  $('#detail').hidden = true;
  $('#inboxView').hidden = false;
  S.inboxPushed = !fromHistory;
  if (!fromHistory) history.pushState({ inbox: true }, '', location.href);
  renderInbox();
  tick();
}

function closeInboxView() {
  S.inboxOpen = false;
  $('#inboxView').hidden = true;
  $('#list').hidden = false;
  tick();
}

function renderInbox() {
  const items = (S.state && S.state.inbox) || [];
  const sig = items.map((x) => x.id).join(',');
  if (sig === S.inboxSig) return;
  S.inboxSig = sig;
  const box = $('#inboxList');
  box.textContent = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'いま、あなたを待っているものはありません';
    box.append(p);
    return;
  }
  items.forEach((x) => box.append(inboxItem(x)));
}

function inboxItem(x) {
  const d = document.createElement('div');
  d.className = 'ibx ibx--' + x.kind;
  const head = document.createElement('div');
  head.className = 'ibx__head';
  const k = document.createElement('span');
  k.className = 'ibx__kind';
  k.textContent = x.kindLabel;
  const t = document.createElement('button');
  t.type = 'button';
  t.className = 'ibx__task';
  t.textContent = x.taskTitle;
  t.addEventListener('click', () => { closeInboxView(); openTask(x.task); });
  const at = document.createElement('span');
  at.textContent = hm(new Date(x.at * 1000));
  head.append(k, t, at);
  const title = document.createElement('div');
  title.className = 'ibx__title';
  title.textContent = x.title;
  d.append(head, title);
  if (x.body) {
    const b = document.createElement('div');
    b.className = 'ibx__body';
    linkify(b, x.body);
    d.append(b);
  }
  if (x.link) {
    const a = document.createElement('a');
    a.className = 'ibx__link';
    a.href = x.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '開く';
    d.append(a);
  }
  let area = null;
  if (x.kind !== 'notify') {
    area = document.createElement('textarea');
    area.rows = 1;
    area.placeholder = x.kind === 'question' ? '答えを書く' : 'ひとこと・直してほしいこと（なくてもよい）';
    d.append(area);
  }
  const btns = document.createElement('div');
  btns.className = 'ibx__btns';
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    btns.append(b);
  };
  const val = () => (area ? area.value.trim() : '');
  if (x.kind === 'notify') {
    btn('見た', 'is-main', () => answerInbox(x, 'seen'));
  } else if (x.kind === 'question') {
    (x.choices || []).forEach((c) => btn(c, '', () => answerInbox(x, 'answer', c)));
    btn('答える', 'is-main', () => { if (val()) answerInbox(x, 'answer', val()); else toast('答えを書いてください'); });
    btn('見送る', 'is-quiet', () => answerInbox(x, 'seen'));
  } else {
    btn('OK', 'is-main', () => answerInbox(x, 'ok', val()));
    btn('直して戻す', '', () => { if (val()) answerInbox(x, 'edit', val()); else toast('どう直すかを書いてください'); });
    btn('やめる', 'is-quiet', () => answerInbox(x, 'no', val()));
  }
  d.append(btns);
  return d;
}

async function answerInbox(x, action, text) {
  try {
    const r = await api('/api/inbox/' + x.id, { action, text: text || '' });
    toast(r.queued ? '預けました。Mac が起きたら AI に届きます'
      : action === 'seen' ? '消しました' : 'AI に届けました');
    if (r.queued) renderRelayBar();
    S.inboxSig = '';
    S.sig = '';
    await loadState();
  } catch (e) {
    toast(e.message);
  }
}

$('#viceCard').addEventListener('click', () => {
  if (S.state && S.state.vice) openTask(S.state.vice.id);
});

// ---------- 1件を開く ----------

function openTask(id, fromHistory) {
  S.open = id;
  S.task = null;
  S.entries = [];
  S.total = 0;
  S.memoTime = null;
  S.memoDirty = false;
  $('#chat').textContent = '';
  $('#memo').value = '';
  $('#memoNote').textContent = '';
  $('#dTitle').textContent = '';
  $('#dSub').textContent = '';
  $('#sendInput').value = '';
  setTab('chat');
  $('#list').hidden = true;
  $('#detail').hidden = false;
  S.chatSig = '';
  S.pushed = !fromHistory;
  if (!fromHistory) history.pushState({ task: id }, '', location.href);   // ★URL は変えない（#p= を残す）
  api('/api/task/' + id + '/read', {}).catch(() => {});
  tick();
}

function closeTask() {
  S.open = null;
  S.task = null;
  $('#detail').hidden = true;
  $('#list').hidden = false;
  tick();
}

$('#back').addEventListener('click', () => {
  if (S.pushed) { history.back(); return; }
  closeTask();
});

window.addEventListener('popstate', () => {
  const st = history.state || {};
  if (st.inbox) { openInboxView(true); return; }
  if (S.inboxOpen) { S.inboxOpen = false; $('#inboxView').hidden = true; }
  if (st.task) openTask(st.task, true);
  else if (S.open) closeTask();
  else { $('#list').hidden = false; tick(); }
});

async function loadTask() {
  const id = S.open;
  const q = '?after=' + (S.task ? S.total : '') + (S.memoTime !== null ? '&memo=' + S.memoTime : '');
  let j;
  try {
    j = await api('/api/task/' + id + q);
  } catch (e) {
    if (e.status === 404) { toast('このタスクは Mac で消されました'); closeTask(); }
    throw e;
  }
  if (S.open !== id) return;
  if (j.full) { renderFull(j); return; }
  const first = !S.task;
  S.task = j.task;
  renderHead();
  // 会話は足すだけ（はじめの1回は最後の150件）
  const chat = $('#chat');
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  if (first) {
    chat.textContent = '';
    if (j.from > 0) {
      const more = document.createElement('div');
      more.className = 'chat__more';
      more.textContent = '前の ' + j.from + ' 件は Mac で見られます';
      chat.append(more);
    }
  }
  j.entries.forEach((e) => chat.append(bubble(e)));
  S.entries = S.entries.concat(j.entries);
  S.total = j.total;
  if (!S.entries.length && !chat.querySelector('.chat__empty')) {
    const em = document.createElement('div');
    em.className = 'chat__empty';
    em.textContent = S.task.kind === 'vice'
      ? 'タスクにする前のことを、何でも書いて送ってください。\nVice の AI がタスクを作って、担当の AI に頼みます。'
      : 'このタスクの AI に頼みたいことを書いて送ってください。';
    chat.append(em);
  } else if (S.entries.length) {
    const em = chat.querySelector('.chat__empty');
    if (em) em.remove();
  }
  if (first || (j.entries.length && nearBottom)) chat.scrollTop = chat.scrollHeight;
  // メモ（書きかけのときは上書きしない）
  if (typeof j.memo === 'string') {
    if (!S.memoDirty) {
      $('#memo').value = j.memo;
      S.memoTime = j.memoTime;
      if (!first) setMemoNote('Mac か AI が書き換えました');
    } else if (j.memoTime !== S.memoTime) {
      setMemoNote('Mac か AI も書き換えています。保存するときに選べます', true);
    }
  } else if (S.memoTime === null) {
    S.memoTime = j.memoTime;
  }
}

/** 預かり口のとき：写しが変わったら、会話を全部描き直す */
function renderFull(j) {
  const first = !S.task;
  S.task = j.task;
  renderHead();
  const sig = JSON.stringify(j.entries.map((e) => e.id)) + j.from;
  const chat = $('#chat');
  if (sig !== S.chatSig) {
    S.chatSig = sig;
    chat.textContent = '';
    if (j.from > 0) {
      const more = document.createElement('div');
      more.className = 'chat__more';
      more.textContent = '前の ' + j.from + ' 件は Mac で見られます';
      chat.append(more);
    }
    j.entries.forEach((e) => chat.append(bubble(e)));
    if (!j.entries.length) {
      const em = document.createElement('div');
      em.className = 'chat__empty';
      em.textContent = 'Mac が切れています。ここに書いて送ると預かって、Mac が起きたら AI に渡します。';
      chat.append(em);
    }
    chat.scrollTop = chat.scrollHeight;
  }
  if (!S.memoDirty && (first || j.memo !== $('#memo').value)) {
    $('#memo').value = j.memo;
    S.memoTime = j.memoTime;
  }
}

function renderHead() {
  const t = S.task;
  if (!t) return;
  $('#dTitle').textContent = t.title;
  const bits = [];
  if (t.kind === 'vice') {
    bits.push('とりあえず投げ込む窓口');
  } else {
    const p = projectOf(t.project);
    if (p) bits.push(p.name);
    if (t.due) bits.push(dueText(t.due));
    if (t.parent) bits.push('← ' + t.parent);
  }
  bits.push(t.permission === t.phonePermission ? t.permission : (t.permission + '（iPhone からは' + t.phonePermission + '）'));
  if (t.model) bits.push(t.model);
  $('#dSub').textContent = bits.join(' · ');
  const done = $('#dDone');
  done.hidden = t.kind === 'vice';
  done.textContent = t.done ? 'おわった ✓' : 'おわった';
  done.classList.toggle('is-done', !!t.done);
  // 作業中
  $('#workBar').hidden = !t.working;
  $('#workText').textContent = t.working || '';
  $('#sendBtn').disabled = !!t.working || S.busy;
}

$('#dDone').addEventListener('click', () => { if (S.open) toggleDone(S.open); });

const tags = { request: 'ほかの AI からの頼み', report: '報告', pending: '預けています（Mac が起きたら AI に渡します）' };

function bubble(e) {
  const d = document.createElement('div');
  d.className = 'msg msg--' + e.role;
  if (tags[e.role]) {
    const t = document.createElement('span');
    t.className = 'msg__tag';
    t.textContent = tags[e.role];
    d.append(t);
  }
  if (e.role === 'assistant' || e.role === 'report' || e.role === 'request') markdown(d, e.text);
  else linkify(d, e.role === 'tool' ? '⚙︎ ' + e.text : e.text);
  return d;
}

/**
 * AI の返事の Markdown を、よく使う形だけ整える（見出し・箇条書き・太字・`コード`・[文](URL)・コードの囲み）。
 * ★innerHTML は使わない。文字はすべて文字として入れる（返事の中の HTML を動かさないため）
 */
function markdown(el, text) {
  el.classList.add('md');
  const lines = text.split('\n');
  let code = null;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (code) { el.append(code); code = null; } else { code = document.createElement('pre'); }
      return;
    }
    if (code) { code.append(line + '\n'); return; }
    let m;
    let block;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      block = document.createElement('strong');
      block.className = 'md__h';
      inline(block, m[2]);
    } else if ((m = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/))) {
      block = document.createElement('span');
      block.className = 'md__li' + (m[1].length >= 2 ? ' md__li--2' : '');
      const mark = line.trim().match(/^\d+[.)]/);
      block.append(mark ? mark[0] + ' ' : '・');
      inline(block, m[2]);
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      block = document.createElement('hr');
    } else {
      block = document.createElement('span');
      inline(block, line);
    }
    el.append(block);
    if (i < lines.length - 1 && block.tagName === 'SPAN') el.append('\n');
  });
  if (code) el.append(code);
}

function inline(el, text) {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) linkify(el, text.slice(last, m.index));
    if (m[1] !== undefined) {
      const b = document.createElement('strong');
      linkify(b, m[1]);
      el.append(b);
    } else if (m[2] !== undefined) {
      const c = document.createElement('code');
      c.textContent = m[2];
      el.append(c);
    } else {
      const a = document.createElement('a');
      a.href = m[4];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[3];
      el.append(a);
    }
    last = re.lastIndex;
  }
  if (last < text.length) linkify(el, text.slice(last));
}

/** 文の中の URL だけをリンクにする（ほかは文字のまま。HTML としては読まない） */
function linkify(el, text) {
  const re = /https?:\/\/[^\s<>"'）」』】]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const url = m[0].replace(/[.,、。)]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    el.append(a);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) el.append(text.slice(last));
}

// ---------- 送る ----------

const input = $('#sendInput');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});

$('#sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !S.open || S.busy) return;
  S.busy = true;
  $('#sendBtn').disabled = true;
  try {
    const r = await api('/api/task/' + S.open + '/send', { text });
    if (r.queued) { renderRelayBar(); S.chatSig = ''; }
    input.value = '';
    input.style.height = 'auto';
    input.blur();
  } catch (err) {
    toast(err.message);
  } finally {
    S.busy = false;
    tick();
  }
});

$('#stopBtn').addEventListener('click', async () => {
  try { await api('/api/task/' + S.open + '/stop', {}); } catch (e) { toast(e.message); }
  tick();
});

// ---------- メモ ----------

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#chatPane').hidden = tab !== 'chat';
  $('#memoPane').hidden = tab !== 'memo';
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

function setMemoNote(text, warn) {
  const n = $('#memoNote');
  n.textContent = text;
  n.classList.toggle('is-warn', !!warn);
}

$('#memo').addEventListener('input', () => {
  S.memoDirty = true;
  setMemoNote('まだ保存していません');
});

$('#memoSave').addEventListener('click', () => saveMemo(false));

async function saveMemo(force) {
  if (!S.open) return;
  const btn = $('#memoSave');
  btn.disabled = true;
  try {
    const j = await api('/api/task/' + S.open + '/memo', { text: $('#memo').value, base: S.memoTime || 0 });
    S.memoTime = j.memoTime;
    S.memoDirty = false;
    setMemoNote(j.queued ? '預けました。Mac が起きたら書きます（Mac でも書き換わっていたら、下に足します）' : '保存しました');
    if (j.queued) renderRelayBar();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.conflict && !force) {
      const keep = confirm('Mac か AI がメモを書き換えています。\n\nOK … iPhone で書いたもので上書きする\nキャンセル … Mac のほうを読み込む（iPhone で書いたぶんは消えます）');
      if (keep) {
        S.memoTime = e.data.memoTime;
        btn.disabled = false;
        return saveMemo(true);
      }
      $('#memo').value = e.data.memo;
      S.memoTime = e.data.memoTime;
      S.memoDirty = false;
      setMemoNote('Mac のほうを読み込みました');
    } else {
      toast(e.message);
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------- 日付 ----------

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function today() { return ymd(new Date()); }
function hm(d) {
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dueText(due) {
  const t = new Date();
  const tm = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  if (due === ymd(t)) return '今日';
  if (due === ymd(tm)) return 'あした';
  const [y, m, d] = due.split('-').map(Number);
  return (y !== t.getFullYear() ? y + '/' : '') + m + '/' + d + (due < ymd(t) ? '（過ぎています）' : '');
}

// ---------- 画面の高さ（キーボードが出ても入力欄が隠れないように） ----------

function fitHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', h + 'px');
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitHeight);
window.addEventListener('resize', fitHeight);
fitHeight();

// ---------- はじめ ----------

async function start() {
  if (!token) { showPair('合言葉がありません。'); return; }
  renderFoot();
  if (APP) {
    // 開けないときでも画面だけは出せるように（https のときだけ使える）
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    }
    try { await Relay.init(CFG); } catch (e) { /* 鍵が読めなければ、預かり口は使わない */ }
    if (!(await probeMac()) && Relay.ready()) await toRelay();
  }
  tick();
}

start();
