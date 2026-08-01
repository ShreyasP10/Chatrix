import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { AccessToken } from 'livekit-server-sdk';

initializeApp();

const livekitSecret = defineSecret('LIVEKIT_SECRET');
const LIVEKIT_API_KEY = 'mykey';

export const getLiveKitToken = onCall(
  { secrets: [livekitSecret], cors: true },
  async (request) => {
    const { roomName, participantName, uid, ttl } = request.data as {
      roomName: string;
      participantName: string;
      uid: string;
      ttl?: string;
    };

    if (!roomName || !participantName || !uid) {
      throw new Error('Missing required fields: roomName, participantName, uid');
    }

    const host = process.env.LIVEKIT_HOST || 'wss://localhost:7880';
    const at = new AccessToken(LIVEKIT_API_KEY, livekitSecret.value(), {
      identity: uid,
      name: participantName,
      ttl: ttl ?? '1h',
      metadata: JSON.stringify({ uid, name: participantName }),
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return { token: at.toJwt(), host };
  }
);

export const onCallStarted = onDocumentCreated(
  'rooms/{roomCode}/calls/current',
  async (event) => {
    const { roomCode } = event.params;
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (!data || !data.active) return;

    const db = getFirestore();
    const membersSnap = await db.collection(`rooms/${roomCode}/members`).get();
    const tokens: string[] = [];
    for (const member of membersSnap.docs) {
      const uid = member.id;
      if (uid === data.initiatorUid) continue;
      const tokenSnap = await db.collection(`users/${uid}/tokens`).get();
      tokenSnap.forEach((t) => tokens.push(t.data().token));
    }

    if (tokens.length === 0) return;

    try {
      await getMessaging().sendEachForMulticast({
        tokens,
        data: {
          type: 'call_started',
          roomCode,
          title: `Call in #${roomCode}`,
          body: `${data.initiatorName || 'Someone'} started a voice call`,
        },
      });
    } catch {}
  }
);

export const onCallEnded = onDocumentDeleted(
  'rooms/{roomCode}/calls/current',
  async (event) => {
    const { roomCode } = event.params;
    const db = getFirestore();
    const membersSnap = await db.collection(`rooms/${roomCode}/members`).get();
    const tokens: string[] = [];
    for (const member of membersSnap.docs) {
      const uid = member.id;
      const tokenSnap = await db.collection(`users/${uid}/tokens`).get();
      tokenSnap.forEach((t) => tokens.push(t.data().token));
    }

    if (tokens.length === 0) return;

    try {
      await getMessaging().sendEachForMulticast({
        tokens,
        data: {
          type: 'call_ended',
          roomCode,
          title: `Call ended in #${roomCode}`,
          body: 'The voice call has ended',
        },
      });
    } catch {}
  }
);

// Moves due scheduled messages (pre-encrypted by the client) into the room's
// message collection. The client encrypts at scheduling time, so the server
// only copies the ciphertext when `sendAtMs` elapses.
export const processScheduledMessages = onSchedule(
  { schedule: 'every 1 minutes', timezone: 'UTC' },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const snap = await db
      .collection('scheduled')
      .where('sendAtMs', '<=', now)
      .limit(200)
      .get();

    for (const doc of snap.docs) {
      const d = doc.data();
      const roomCode = d.roomCode;
      if (!roomCode) {
        await doc.ref.delete().catch(() => {});
        continue;
      }
      const { roomCode: _rc, sendAtMs: _ts, ...msgData } = d;
      try {
        await db.collection(`rooms/${roomCode}/messages`).add({
          ...msgData,
          timestamp: FieldValue.serverTimestamp(),
          seq: Date.now(),
          scheduled: true,
        });
        await db.doc(`rooms/${roomCode}`).update({ lastActivityAt: FieldValue.serverTimestamp() }).catch(() => {});
      } catch {}
      await doc.ref.delete().catch(() => {});
    }
  }
);
