// Service worker: permet instal·lar l'app, obrir-la sense xarxa i rebre avisos push.
const CACHE = 'ara-v2';
const SHELL = ['./', 'index.html', 'style.css', 'logic.js', 'app.js', 'config.js', 'icon.svg', 'icon-192.png',
  'badge-96.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Xarxa primer (per tenir sempre la versió nova), memòria cau si no hi ha xarxa.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// ---------- Avisos push ----------
// normal: sense so · important i resum: so · urgent: es queda fins que el toques.
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  const level = m.level || 'normal';
  const options = {
    body: m.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: m.tag || undefined,
    renotify: !!m.tag && level !== 'normal',
    silent: level === 'normal',
    requireInteraction: level === 'urgent',
    data: { task_id: m.task_id || null },
    actions: m.task_id ? [{ action: 'done', title: 'Fet' }, { action: 'later', title: 'Més tard' }] : [],
  };
  e.waitUntil(self.registration.showNotification(m.title || 'Ara', options));
});

// Tocar l'avís obre l'app (o la porta al davant). Els botons passen l'acció a l'app.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const taskId = e.notification.data && e.notification.data.task_id;
  const action = e.action || (taskId ? 'open' : '');
  const target = new URL('./', self.registration.scope);
  if (taskId && action) { target.searchParams.set('task', taskId); target.searchParams.set('do', action); }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) {
      if (taskId) win.postMessage({ type: 'notification', task_id: taskId, action });
      return win.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
