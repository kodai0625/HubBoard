'use strict';
// iPhone アプリ（GitHub Pages）の読み込みの世話係（設計.md「段階5」）。
// 画面のファイルだけを控えて、電波が弱いときでも画面は開けるようにする。
// ★Mac・預かり口とのやり取り（よそのサーバー）は控えない（中身を端末に残さないため。写しは暗号のまま app 側が持つ）
// ★版の印は 公開用を作る.py が中身から入れる
const VERSION = '4362b05d';
const CACHE = 'hubboard-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './relay.js', './style.css', './icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n.startsWith('hubboard-') && n !== CACHE ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // Mac・預かり口は素通し
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;   // 自分のフォルダの中だけ
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());   // ★エラーの画面は控えない
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
