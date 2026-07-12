import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { localDB } from '../lib/db';
import { deriveKey, decrypt } from '../lib/crypto';
import { useStore } from '../store/useStore';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import OtpInput from '../components/OtpInput';
import Avatar from '../components/Avatar';
import type { JoinedRoom } from '../types';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export default function Dashboard() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const navigate = useNavigate();
  const { user, joinedRooms, setJoinedRooms, addJoinedRoom } = useStore();
  const { showPrompt, install } = useInstallPrompt();

  useEffect(() => {
    localDB.joinedRooms.toArray().then((rooms) => {
      setJoinedRooms(rooms);
      const codes = rooms.map((r) => r.code);
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'WATCH_ROOMS', rooms: codes });
      }
    });
  }, [setJoinedRooms]);

  useEffect(() => {
    if (user && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [user]);

  useEffect(() => {
    if (!user || Notification.permission !== 'granted') return;
    let cancelled = false;
    (async () => {
      try {
        const { getMessaging, getToken } = await import('firebase/messaging');
        const messaging = getMessaging();
        const token = await getToken(messaging, { vapidKey: VAPID_KEY });
        if (token && !cancelled) {
          await setDoc(doc(db, 'users', user.uid, 'tokens', token), {
            token,
            platform: 'web',
            createdAt: serverTimestamp(),
            lastUsed: serverTimestamp(),
          });
        }
      } catch {
        // FCM not configured or unavailable — silently skip
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const joinRoom = async () => {
    if (code.length !== 4) return;
    setLoading('join');
    setError('');
    try {
      const snap = await getDoc(doc(db, 'rooms', code));
      if (!snap.exists()) {
        setError('Room not found');
        setLoading('');
        return;
      }
      if (user) {
        await setDoc(doc(db, 'rooms', code, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      }
      const room: JoinedRoom = {
        code,
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const allRooms = [...useStore.getState().joinedRooms.map((r) => r.code), code];
        navigator.serviceWorker.controller.postMessage({ type: 'WATCH_ROOMS', rooms: allRooms });
      }
      navigate(`/chat/${code}`);
    } catch {
      setError('Failed to join room');
    }
    setLoading('');
  };

  const createRoom = async () => {
    setLoading('create');
    setError('');
    let newCode: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = String(Math.floor(Math.random() * 9000) + 1000);
      const snap = await getDoc(doc(db, 'rooms', candidate));
      if (!snap.exists()) {
        newCode = candidate;
        break;
      }
    }
    if (!newCode) {
      setError('Could not generate unique code. Try again.');
      setLoading('');
      return;
    }
    try {
      await setDoc(doc(db, 'rooms', newCode), {
        createdAt: serverTimestamp(),
        createdBy: user?.uid,
      });
      if (user) {
        await setDoc(doc(db, 'rooms', newCode, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      }
      const room: JoinedRoom = {
        code: newCode,
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      navigate(`/chat/${newCode}`);
    } catch {
      setError('Failed to create room');
    }
    setLoading('');
  };

  const getLastMessage = useCallback(async (roomCode: string) => {
    try {
      const q = query(
        collection(db, 'rooms', roomCode, 'messages'),
        orderBy('timestamp', 'desc'),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.empty) return null;
      const data = snap.docs[0].data();
      const key = await deriveKey(roomCode);
      const text = await decrypt(data.ciphertext, data.iv, key);
      return {
        text: text.slice(0, 40),
        timestamp: data.timestamp?.toMillis() ?? Date.now(),
        senderUid: data.senderUid,
      };
    } catch {
      return null;
    }
  }, []);

  return (
    <div className="flex flex-col items-center min-h-dvh px-4 py-8 max-w-md mx-auto">
      {user && (
        <div className="flex items-center gap-3 mb-4 self-start">
          <Avatar name={user.name} size="lg" />
          <div>
            <p className="text-sm font-semibold">{user.name}</p>
            <p className="text-xs text-[#B3B3B3]">Chatrix</p>
          </div>
        </div>
      )}
      <h1 className="text-3xl font-bold tracking-tight mb-2">Chatrix</h1>
      <p className="text-sm text-[#B3B3B3] mb-10">Anonymous &middot; Encrypted</p>

      <OtpInput value={code} onChange={setCode} />

      {error && (
        <p className="mt-3 text-sm text-red-400">{error}</p>
      )}

      <div className="flex gap-3 w-full mt-6">
        <button
          onClick={joinRoom}
          disabled={code.length !== 4 || loading === 'join'}
          className="flex-1 py-3 rounded-xl font-semibold bg-[#007AFF] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#0066CC] transition-colors"
        >
          {loading === 'join' ? 'Joining...' : 'Join'}
        </button>
        <button
          onClick={createRoom}
          disabled={loading === 'create'}
          className="flex-1 py-3 rounded-xl font-semibold border-2 border-[#007AFF] text-[#007AFF] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#007AFF]/10 transition-colors"
        >
          {loading === 'create' ? 'Creating...' : '+ Create'}
        </button>
      </div>

      {showPrompt && (
        <button
          onClick={install}
          className="mt-6 text-sm text-[#007AFF] hover:underline"
        >
          Install App
        </button>
      )}

      {joinedRooms.length > 0 && (
        <div className="w-full mt-10">
          <h2 className="text-sm font-semibold text-[#B3B3B3] uppercase tracking-wide mb-3">
            Your Chats
          </h2>
          <div className="space-y-2">
            {joinedRooms.map((room) => (
              <RoomItem
                key={room.code}
                room={room}
                onEnter={() => navigate(`/chat/${room.code}`)}
                getLastMessage={getLastMessage}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RoomItem({
  room,
  onEnter,
  getLastMessage,
}: {
  room: JoinedRoom;
  onEnter: () => void;
  getLastMessage: (code: string) => Promise<{ text: string; timestamp: number; senderUid: string } | null>;
}) {
  const [preview, setPreview] = useState<{ text: string; timestamp: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLastMessage(room.code).then((msg) => {
      if (msg && !cancelled) setPreview(msg);
    });
    return () => { cancelled = true; };
  }, [room.code, getLastMessage]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hr ago`;
    return d.toLocaleDateString();
  };

  return (
    <button
      onClick={onEnter}
      className="w-full flex items-center gap-3 p-4 rounded-xl border border-[#333] bg-[#0D0D0D] text-left hover:border-[#555] transition-colors"
    >
      <div className="w-10 h-10 rounded-full bg-[#1C1C1E] flex items-center justify-center font-bold text-[#007AFF] shrink-0">
        #{room.code}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">Room #{room.code}</p>
        <p className="text-xs text-[#B3B3B3] truncate mt-0.5">
          {preview ? preview.text : 'No messages yet'}
        </p>
      </div>
      {preview && (
        <span className="text-xs text-[#555] shrink-0">
          {formatTime(preview.timestamp)}
        </span>
      )}
    </button>
  );
}
