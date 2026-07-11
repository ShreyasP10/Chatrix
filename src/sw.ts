/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('push', (event) => {
  let data: any;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (!data) return;

  // Handle both Cloud Function format (data.notification + data.data)
  // and direct format
  const payload = data.data || data;
  const roomCode = payload.roomCode;
  const notificationData = data.notification || {};
  const title = notificationData.title || data.title || 'ChatWave';
  const body = notificationData.body || data.body || 'New message';

  const notificationOptions: NotificationOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { roomCode, type: payload.type || 'new_message' },
    tag: roomCode ? `chatwave-${roomCode}` : 'chatwave',
  };

  event.waitUntil(
    self.registration.showNotification(title, notificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomCode = event.notification.data?.roomCode;
  const url = roomCode ? `/chat/${roomCode}` : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          const clientUrl = new URL(client.url);
          const targetUrl = new URL(url, self.location.origin);
          if (clientUrl.pathname === targetUrl.pathname && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
