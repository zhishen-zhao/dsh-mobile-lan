/*
 * Retirement worker for older dsh-mobile-remote PWA installs.
 *
 * The phone companion is intentionally online-only: it is useful only while
 * it can connect to the paired local Harness. Older cache-first workers could
 * retain incompatible HTML/CSS/JS after a plugin update and leave WebView
 * blank. Install this once to clear that state, then unregister itself.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((key) => key.startsWith("dsh-mobile-")).map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clients.map((client) => client.navigate(client.url)));
  })());
});
