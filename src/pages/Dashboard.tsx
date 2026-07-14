import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
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
import { swSend } from '../lib/sw';
import OtpInput from '../components/OtpInput';
import Avatar from '../components/Avatar';
import type { JoinedRoom } from '../types';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export default function Dashboard() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const navigate = useNavigate();
  const { user, setUser, joinedRooms, setJoinedRooms, addJoinedRoom } = useStore();
  const { showPrompt, install } = useInstallPrompt();
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localDB.joinedRooms.toArray().then((rooms) => {
      setJoinedRooms(rooms);
      const codes = rooms.map((r) => r.code);
      swSend({ type: 'WATCH_ROOMS', rooms: codes });
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
      const allRooms = [...useStore.getState().joinedRooms.map((r) => r.code), code];
      swSend({ type: 'WATCH_ROOMS', rooms: allRooms });
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

  const startEditName = () => {
    if (!user) return;
    setNameInput(user.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const saveName = async () => {
    if (!user) return;
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === user.name) {
      setEditingName(false);
      return;
    }
    const updated = { ...user, name: trimmed };
    setUser(updated);
    await localDB.userProfile.put(updated);
    try {
      await updateDoc(doc(db, 'users', user.uid), { name: trimmed });
    } catch {}
    setEditingName(false);
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
        <div className="flex items-center gap-3 mb-6 self-start w-full animate-fade-in group">
          <div className="relative">
            <Avatar name={user.name} size="lg" />
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-[#00FF88] rounded-full border-2 border-black" />
          </div>
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  onBlur={saveName}
                  maxLength={30}
                  className="bg-[#1C1C1E] text-white text-sm font-semibold rounded-lg px-2 py-1.5 outline-none border border-[#333] w-full"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">{user.name}</p>
                <button onClick={startEditName} className="text-[#555] hover:text-[#007AFF] transition-colors opacity-0 group-hover:opacity-100">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                    <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                  </svg>
                </button>
              </div>
            )}
            <p className="text-xs text-[#555]">Chatrix</p>
          </div>
        </div>
      )}

      <div className="w-full text-center mb-8 animate-fade-in">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#007AFF] to-[#5856D6] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[#007AFF]/20">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-white">
            <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z" />
            <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Chatrix</h1>
        <p className="text-xs text-[#555] mt-1">Anonymous &middot; Encrypted</p>
      </div>

      <div className="w-full animate-slide-up">
        <OtpInput value={code} onChange={setCode} />

        {error && (
          <p className="mt-3 text-sm text-red-400 text-center">{error}</p>
        )}

        <div className="flex gap-3 w-full mt-6">
          <button
            onClick={joinRoom}
            disabled={code.length !== 4 || loading === 'join'}
            className="flex-1 py-3 rounded-xl font-semibold bg-[#007AFF] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#0066CC] active:scale-[0.98] transition-all"
          >
            {loading === 'join' ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Joining
              </span>
            ) : 'Join'}
          </button>
          <button
            onClick={createRoom}
            disabled={loading === 'create'}
            className="flex-1 py-3 rounded-xl font-semibold border border-[#333] text-[#B3B3B3] disabled:opacity-30 disabled:cursor-not-allowed hover:border-[#555] hover:text-white active:scale-[0.98] transition-all"
          >
            {loading === 'create' ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-[#555] border-t-white rounded-full animate-spin" />
                Creating
              </span>
            ) : 'Create'}
          </button>
        </div>
      </div>

      {showPrompt && (
        <button
          onClick={install}
          className="mt-6 text-xs text-[#555] hover:text-[#007AFF] transition-colors"
        >
          Install App
        </button>
      )}

      {joinedRooms.length > 0 && (
        <div className="w-full mt-12 animate-fade-in">
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-[11px] font-semibold text-[#444] uppercase tracking-[0.15em]">
              Your Rooms
            </h2>
            <span className="text-[10px] text-[#333] font-mono">
              {joinedRooms.length} room{joinedRooms.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="space-y-2">
            {[...joinedRooms].reverse().map((room) => (
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
  const [preview, setPreview] = useState<{ text: string; timestamp: number; senderUid: string } | null>(null);
  const { user } = useStore();

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
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  function roomGradient(code: string) {
    let hash = 0;
    for (let i = 0; i < code.length; i++) hash = code.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return `linear-gradient(135deg, hsl(${h}, 55%, 40%), hsl(${(h + 40) % 360}, 50%, 30%))`;
  }

  return (
    <button
      onClick={onEnter}
      className="w-full flex items-center gap-4 p-4 rounded-2xl border border-[#222] bg-[#0D0D0D] text-left hover:bg-[#141414] hover:border-[#444] transition-all active:scale-[0.98] group"
    >
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-lg"
        style={{ background: roomGradient(room.code) }}
      >
        #{room.code}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-white">Room #{room.code}</p>
          {preview && (
            <span className="text-[10px] text-[#555] shrink-0 font-medium">
              {formatTime(preview.timestamp)}
            </span>
          )}
        </div>
        <p className="text-xs text-[#666] truncate mt-1 flex items-center gap-1">
          {preview ? (
            <>
              <span className={preview.senderUid === user?.uid ? 'text-[#007AFF]' : 'text-[#00FF88]'}>
                {preview.senderUid === user?.uid ? 'You' : preview.senderUid?.slice(0, 6)}
              </span>
              <span className="text-[#444]">&middot;</span>
              <span>{preview.text}</span>
            </>
          ) : (
            <span className="text-[#555] italic">No messages yet</span>
          )}
        </p>
      </div>
      <div className="w-2 h-2 rounded-full bg-[#007AFF] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}
