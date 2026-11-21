const offlinePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Coach is offline</title>
  <style>
    body{background:#f6f6ef;color:#293626;font:1rem/1.55 system-ui,sans-serif;margin:2rem}
    main{max-width:34rem;margin:4rem auto}a{color:#36562d}
  </style>
</head>
<body>
  <main><h1>Coach is offline</h1><p>Reconnect to open your lessons and sync your quiz progress.</p><a href="/">Try again</a></main>
</body>
</html>`;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['/', '/index.html'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(() => new Response(offlinePage, {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })));
});
