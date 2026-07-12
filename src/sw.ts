/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);

// ─── Firestore-based notification watcher ──────────────────────
// Avoids needing Cloud Functions (Blaze plan). The SW listens
// directly to Firestore for new messages in joined rooms.
// ───────────────────────────────────────────────────────────────

let firebaseApp: any = null;
let firestoreDb: any = null;
let userUid: string | null = null;
let roomUnsubs: Map<string, () => void> = new Map();
let activeRoom: string | null = null; // room the user is currently viewing

self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'FIREBASE_CONFIG':
      initFirebase(event.data.config);
      break;
    case 'USER_UID':
      userUid = event.data.uid;
      break;
    case 'WATCH_ROOMS':
      watchRooms(event.data.rooms);
      break;
    case 'ACTIVE_ROOM':
      activeRoom = event.data.code;
      break;
    case 'LEAVE_ROOM':
      const unsub = roomUnsubs.get(event.data.code);
      if (unsub) { unsub(); roomUnsubs.delete(event.data.code); }
      break;
  }
});

async function initFirebase(config: any) {
  if (firebaseApp) return;
  const { initializeApp } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  firebaseApp = initializeApp(config);
  firestoreDb = getFirestore(firebaseApp);
}

async function watchRooms(rooms: string[]) {
  if (!firestoreDb) return;

  // Unwatch stale rooms
  for (const [code, unsub] of roomUnsubs) {
    if (!rooms.includes(code)) {
      unsub();
      roomUnsubs.delete(code);
    }
  }

  const { collection, query, orderBy, limit, onSnapshot } = await import('firebase/firestore');

  for (const code of rooms) {
    if (roomUnsubs.has(code)) continue;
    const q = query(
      collection(firestoreDb, 'rooms', code, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(1)
    );
    const unsub = onSnapshot(q, (snap: any) => {
      snap.docChanges().forEach((change: any) => {
        if (change.type === 'added') {
          handleNewMessage(code, change.doc.data(), change.doc.id);
        }
      });
    });
    roomUnsubs.set(code, unsub);
  }
}

function handleNewMessage(roomCode: string, data: any, _docId: string) {
  // Don't notify if user sent it
  if (data.senderUid === userUid) return;
  // Don't notify if user is viewing this room
  if (roomCode === activeRoom) return;

  const senderName = data.senderName || 'Someone';
  let title = `Chatrix`;
  let body = `${senderName} sent a message in #${roomCode}`;

  // Check for reply (replyToUid is plaintext in the doc)
  if (data.replyToUid && data.replyToUid === userUid) {
    title = `📬 Reply from ${senderName}`;
    body = `${senderName} replied to you in #${roomCode}`;
  }
  // Check for @mention (mentionedUids is plaintext in the doc)
  else if (data.mentionedUids?.includes(userUid)) {
    title = `📢 ${senderName} mentioned you`;
    body = `${senderName} mentioned you in #${roomCode}`;
  }

  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { roomCode, type: 'new_message' },
    tag: `chatrix-${roomCode}`,
  });
}

// ─── FCM push handler (fallback for server-triggered pushes) ───

self.addEventListener('push', (event) => {
  let data: any;
  try { data = event.data?.json(); } catch { return; }
  if (!data) return;

  const payload = data.data || data;
  const roomCode = payload.roomCode;
  const nData = data.notification || {};
  const title = nData.title || data.title || 'Chatrix';
  const body = nData.body || data.body || 'New message';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { roomCode, type: payload.type || 'new_message' },
      tag: roomCode ? `chatrix-${roomCode}` : 'chatrix',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomCode = event.notification.data?.roomCode;
  const url = roomCode ? `/chat/${roomCode}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
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
