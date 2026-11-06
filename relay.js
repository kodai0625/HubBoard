'use strict';
// Mac が切れているときの預かり口（設計.md「段階5」。Mac の側は Sources/Relay.swift、受け口は gas/コード.gs）
//
// ・Mac の最後の写し（一覧・会話・メモ）を預かり口から読んで見せる
// ・足す・送る・メモ・おわった を、暗号にして預かり口に預ける。Mac が起きたら Mac が受け取って動かす
// ・Mac の API と同じ形で答えるので、app.js の画面はそのまま使える（Relay.api）
//
// ★暗号は AES-GCM（256ビット）。base64( nonce12 + 暗号 + tag16 )。鍵は QR の # の後ろで受け取り、
//   取り出せない形（extractable: false）でだけ持つ。Google には鍵が無いので読めない
// ★この端末に残すのは、暗号のままの写しと、暗号にした「預けた頼み」の控えだけ

const RELAY_AAD = {
  snapshot: 'hubboard-snapshot-v1',
  cmd: 'hubboard-cmd-v1',
  pending: 'hubboard-pending-v1',
};

function b64ToBytes(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const Relay = {
  cfg: null,
  key: null,
  snap: null,          // 復号した写し { state, tasks, results }
  snapAt: 0,           // 写しを Mac が送った時刻（ミリ秒）
  pending: [],         // 預けた頼み（Mac の結果が写しに出るまで）

  async init(cfg) {
    this.cfg = cfg;
    if (!cfg || !cfg.g || !cfg.p || !cfg.k) return;
    this.key = await crypto.subtle.importKey('raw', b64ToBytes(cfg.k), 'AES-GCM', false, ['encrypt', 'decrypt']);
    await this.loadPending();
    await this.loadCachedSnap();
  },

  ready() { return !!(this.cfg && this.cfg.g && this.cfg.p && this.key); },

  // ---------- 暗号 ----------

  async seal(obj, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, this.key, plain));
    const all = new Uint8Array(12 + ct.length);
    all.set(iv, 0);
    all.set(ct, 12);
    return bytesToB64(all);
  },

  async open(b64, aad, compressed) {
    const all = b64ToBytes(b64);
    let plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: new TextEncoder().encode(aad) },
      this.key, all.subarray(12)));
    if (compressed) plain = await pipeBytes(plain, new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(plain));
  },

  // ---------- 預かり口とのやり取り ----------

  async post(action, extra) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      // text/plain で送る（Apps Script は application/json の事前確認に応えないため）
      res = await fetch(this.cfg.g, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ pin: this.cfg.p, action }, extra || {})),
        cache: 'no-store',
        signal: ctl.signal,
      });
    } catch (e) {
      const err = new Error('預かり口にもつながりません（電波を確かめてください）');
      err.network = true;
      throw err;
    } finally {
      clearTimeout(tm);
    }
    let j = null;
    try { j = await res.json(); } catch (e) { /* 下で知らせる */ }
    if (!j || j.ok !== true) throw new Error((j && j.error) || ('預かり口がうまく答えませんでした（' + res.status + '）'));
    return j;
  },

  /** 最後の写しを読む。読めたら、済んだ「預けた頼み」を返す */
  async refresh() {
    const r = await this.post('getSnapshot');
    if (!r.data) return [];
    this.snap = await this.open(r.data, RELAY_AAD.snapshot, true);
    this.snapAt = r.at || 0;
    store.set('hub-snap', JSON.stringify({ at: this.snapAt, data: r.data }));
    return this.reconcile();
  },

  async loadCachedSnap() {
    try {
      const c = JSON.parse(store.get('hub-snap') || 'null');
      if (!c || !c.data) return;
      this.snap = await this.open(c.data, RELAY_AAD.snapshot, true);
      this.snapAt = c.at || 0;
    } catch (e) { /* 鍵が変わった など。読めなければ使わない */ }
  },

  /** Mac が動かした頼みを、控えから消す */
  reconcile() {
    const results = (this.snap && this.snap.results) || [];
    const byId = new Map(results.map((r) => [r.id, r]));
    const finished = [];
    const left = [];
    this.pending.forEach((p) => {
      if (byId.has(p.id)) finished.push(Object.assign({}, p, { result: byId.get(p.id) }));
      else left.push(p);
    });
    if (finished.length) {
      this.pending = left;
      this.savePending();
    }
    return finished;
  },

  async queue(cmd) {
    const c = Object.assign({ id: crypto.randomUUID(), at: Date.now() }, cmd);
    await this.post('queue', { id: c.id, data: await this.seal(c, RELAY_AAD.cmd) });
    this.pending.push(c);
    await this.savePending();
    return c;
  },

  async savePending() {
    try { store.set('hub-pending', this.pending.length ? await this.seal(this.pending, RELAY_AAD.pending) : ''); } catch (e) { /* 控えが書けなくても、預けたものは預かり口にある */ }
  },

  async loadPending() {
    const b = store.get('hub-pending');
    if (!b) return;
    try { this.pending = await this.open(b, RELAY_AAD.pending, false); } catch (e) { this.pending = []; }
  },

  // ---------- Mac の API と同じ形で答える ----------

  findTask(id) {
    const st = this.snap && this.snap.state;
    if (!st) return null;
    if (st.vice && st.vice.id === id) return st.vice;
    for (const sec of st.sections) for (const t of sec.tasks) if (t.id === id) return t;
    return null;
  },

  /** 預けた「おわった」を足した、いまの状態 */
  doneOf(t) {
    let d = !!t.done;
    this.pending.forEach((p) => { if (p.kind === 'done' && p.task === t.id) d = !!p.done; });
    return d;
  },

  state() {
    const st = JSON.parse(JSON.stringify(this.snap.state));
    st.working = 0;
    st.relay = true;
    // 答えを預けたあなた待ちは、もう出さない
    st.inbox = (st.inbox || []).filter((x) => !this.pending.some((p) => p.kind === 'inbox' && p.item === x.id));
    const fix = (t) => {
      t.working = null;                         // Mac が切れているので、動いていない
      t.done = this.doneOf(t);
      const sends = this.pending.filter((p) => p.kind === 'send' && p.task === t.id);
      if (sends.length) t.lastLine = '預けています：' + sends[sends.length - 1].text;
    };
    if (st.vice) fix(st.vice);
    st.sections.forEach((s) => s.tasks.forEach(fix));
    const adds = this.pending.filter((p) => p.kind === 'add');
    if (adds.length) {
      st.sections.unshift({
        id: 'pending',
        title: '預けている（Mac が起きたら足します）',
        tasks: adds.map((p) => ({ id: 'pending-' + p.id, kind: 'pending', title: p.title, project: p.project || null,
          due: null, done: false, pinned: false, unread: false, working: null, lastLine: '', mail: false, parent: null })),
      });
    }
    return st;
  },

  task(id, t) {
    const d = (this.snap.tasks || {})[id] || { total: 0, from: 0, entries: [], memo: '', memoTime: 0 };
    const tt = JSON.parse(JSON.stringify(t));
    tt.working = null;
    tt.done = this.doneOf(t);
    const entries = d.entries.slice();
    this.pending.filter((p) => p.kind === 'send' && p.task === id).forEach((p) => {
      entries.push({ id: p.id, role: 'pending', text: p.text, time: p.at / 1000 });
    });
    let memo = d.memo;
    this.pending.filter((p) => p.kind === 'memo' && p.task === id).forEach((p) => { memo = p.text; });
    return { ok: true, full: true, task: tt, total: d.total, from: d.from, entries, memo, memoTime: d.memoTime };
  },

  async api(path, body) {
    if (!this.snap || !this.snap.state) {
      throw new Error('まだ Mac の写しがありません。いちど Mac を起こしてから、開き直してください');
    }
    if (path === '/api/state') return this.state();
    if (path === '/api/routine' && body) {
      await this.queue({ kind: 'routine', action: body.action });
      return { ok: true, queued: true };
    }
    const ib = path.match(/^\/api\/inbox\/([0-9A-Fa-f-]{36})$/);
    if (ib && body) {
      await this.queue({ kind: 'inbox', item: ib[1], action: body.action, text: body.text || '' });
      return { ok: true, queued: true };
    }
    if (path === '/api/task' && body) {
      await this.queue({ kind: 'add', title: body.title, project: body.project || null });
      return { ok: true, queued: true };
    }
    const m = path.match(/^\/api\/task\/([0-9A-Fa-f-]{36})(?:\/(\w+))?/);
    if (!m) throw new Error('Mac が切れているので、できません');
    const id = m[1];
    const act = m[2] || '';
    const t = this.findTask(id);
    if (!t) {
      const e = new Error('このタスクは、Mac の写しにありません');
      e.status = 404;
      throw e;
    }
    if (!body) return this.task(id, t);
    switch (act) {
      case 'send':
        await this.queue({ kind: 'send', task: id, text: body.text });
        return { ok: true, queued: true };
      case 'done': {
        const want = !this.doneOf(t);
        await this.queue({ kind: 'done', task: id, done: want });
        return { ok: true, queued: true, done: want };
      }
      case 'memo':
        await this.queue({ kind: 'memo', task: id, text: body.text, base: body.base || 0 });
        return { ok: true, queued: true, memoTime: body.base || 0 };
      case 'read':
        return { ok: true };
      case 'ask':
        await this.queue({ kind: 'ask', task: id });
        return { ok: true, queued: true };
      default:
        throw new Error('Mac が切れているので、できません');
    }
  },
};
