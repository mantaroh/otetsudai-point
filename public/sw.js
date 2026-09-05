/// <reference lib="webworker" />
/*
 * Service Worker。
 *
 * 狙いは2つだけ:
 *   1. ホーム画面から開いたときに、すぐ画面が出ること
 *   2. 電波が切れても真っ白にならず、「つながっていません」と分かること
 *
 * **台帳のデータはキャッシュしない。** シールの枚数が古いまま出るのが
 * いちばん困る(貼ったのに増えていない、交換ずみなのに残っている)ので、
 * /api/ 以下はいっさい触らず、常にネットワークに行かせる。
 */

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const SHELL_URL = "/";

const OFFLINE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>おてつだいポイント</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;
       background:#fdf7ec;color:#3d3428;
       font-family:"Hiragino Maru Gothic ProN","Yu Gothic UI",system-ui,sans-serif;text-align:center}
  p{margin:.5rem}
  .big{font-size:3rem}
  .soft{color:#8a7c68;font-size:.9rem}
</style></head>
<body><div>
  <p class="big">📡</p>
  <p><b>インターネットにつながっていません</b></p>
  <p class="soft">つながったら、もういちど開いてください</p>
</div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 取れなくてもインストールは止めない(初回がオフラインでも壊さない)
      await cache.add(SHELL_URL).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API・認証・招待は、必ず本物のサーバに行かせる
  if (/^\/(api|auth|invite)(\/|$)/.test(url.pathname)) return;

  // 画面の読み込み。新しいものを優先し、だめならキャッシュ、それもなければオフライン表示
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put(SHELL_URL, response.clone());
          return response;
        } catch {
          const cached = await caches.match(SHELL_URL);
          return (
            cached ??
            new Response(OFFLINE_HTML, {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // ビルド成果物はファイル名にハッシュが付くので、あるものはそのまま使ってよい
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
