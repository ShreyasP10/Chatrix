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
  onSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { localDB } from '../lib/db';
import { deriveKey, decrypt } from '../lib/crypto';
import { useStore } from '../store/useStore';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { swSend } from '../lib/sw';
import Avatar from '../components/Avatar';
import type { JoinedRoom } from '../types';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

function sanitizeRoomName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50) || 'room';
}

export default function Dashboard() {
  const [roomName, setRoomName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const navigate = useNavigate();
  const { user, setUser, joinedRooms, setJoinedRooms, addJoinedRoom, removeJoinedRoom } = useStore();
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
    const name = sanitizeRoomName(roomName);
    if (!name) return;
    setLoading('join');
    setError('');
    try {
      const snap = await getDoc(doc(db, 'rooms', name));
      if (!snap.exists()) {
        setError('Room not found');
        setLoading('');
        return;
      }
      if (user) {
        await setDoc(doc(db, 'rooms', name, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      }
      const roomData = snap.data();
      const room: JoinedRoom = {
        code: name,
        displayName: roomData.displayName || name,
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      const allRooms = [...useStore.getState().joinedRooms.map((r) => r.code), name];
      swSend({ type: 'WATCH_ROOMS', rooms: allRooms });
      navigate(`/chat/${name}`);
    } catch {
      setError('Failed to join room');
    }
    setLoading('');
  };

  const createRoom = async () => {
    const name = sanitizeRoomName(roomName);
    if (!name) {
      setError('Enter a room name');
      return;
    }
    setLoading('create');
    setError('');
    try {
      const snap = await getDoc(doc(db, 'rooms', name));
      if (snap.exists()) {
        setError('Room already exists. Use Join instead.');
        setLoading('');
        return;
      }
      await setDoc(doc(db, 'rooms', name), {
        createdAt: serverTimestamp(),
        createdBy: user?.uid,
        displayName: roomName.trim(),
      });
      if (user) {
        await setDoc(doc(db, 'rooms', name, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      }
      const room: JoinedRoom = {
        code: name,
        displayName: roomName.trim(),
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      navigate(`/chat/${name}`);
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
      const decrypted = await decrypt(data.ciphertext, data.iv, key);
      const parsed = JSON.parse(decrypted);
      return {
        text: (parsed.text || decrypted).slice(0, 40),
        timestamp: data.timestamp?.toMillis() ?? Date.now(),
        senderUid: data.senderUid,
        senderName: data.senderName || data.senderUid?.slice(0, 6),
      };
    } catch {
      return null;
    }
  }, []);

  return (
    <div className="flex flex-col items-center min-h-dvh px-4 py-8 max-w-md md:max-w-lg lg:max-w-xl mx-auto">
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
        <div className="flex items-center gap-2 bg-[#0D0D0D] border-2 border-[#333] rounded-xl px-4 py-3 focus-within:border-[#007AFF] transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-[#555] shrink-0">
            <path fillRule="evenodd" d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') joinRoom();
            }}
            placeholder="Enter room name..."
            maxLength={50}
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder-[#555]"
          />
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-400 text-center">{error}</p>
        )}

        <div className="flex gap-3 w-full mt-6">
          <button
            onClick={joinRoom}
            disabled={!roomName.trim() || loading === 'join'}
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
            disabled={!roomName.trim() || loading === 'create'}
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
        <div className="w-full mt-10 animate-fade-in">
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="h-3 w-0.5 rounded-full bg-[#007AFF]" />
            <h2 className="text-[11px] font-semibold text-[#555] uppercase tracking-[0.15em]">
              Your Rooms
            </h2>
            <span className="text-[10px] text-[#333] font-mono ml-auto">
              {joinedRooms.length}
            </span>
          </div>
          <div className="space-y-1">
            {[...joinedRooms].reverse().map((room) => (
              <RoomItem
                key={room.code}
                room={room}
                onEnter={() => navigate(`/chat/${room.code}`)}
                onDelete={() => {
                  localDB.joinedRooms.delete(room.code);
                  removeJoinedRoom(room.code);
                  const remaining = useStore.getState().joinedRooms.map((r) => r.code);
                  swSend({ type: 'WATCH_ROOMS', rooms: remaining });
                }}
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
  onDelete,
  getLastMessage,
}: {
  room: JoinedRoom;
  onEnter: () => void;
  onDelete: () => void;
  getLastMessage: (code: string) => Promise<{ text: string; timestamp: number; senderUid: string; senderName: string } | null>;
}) {
  const [preview, setPreview] = useState<{ text: string; timestamp: number; senderUid: string; senderName: string } | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState(room.displayName || room.code);
  const { user } = useStore();

  useEffect(() => {
    let cancelled = false;
    getLastMessage(room.code).then((msg) => {
      if (msg && !cancelled) setPreview(msg);
    });
    getDocs(collection(db, 'rooms', room.code, 'members')).then((snap) => {
      if (!cancelled) setMemberCount(snap.size);
    });
    return () => { cancelled = true; };
  }, [room.code, getLastMessage]);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'rooms', room.code), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.displayName) setDisplayName(data.displayName);
      }
    });
    return unsub;
  }, [room.code]);

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

  function roomGradient(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return `linear-gradient(135deg, hsl(${h}, 55%, 40%), hsl(${(h + 40) % 360}, 50%, 30%))`;
  }

  return (
    <button
      onClick={onEnter}
      className="w-full flex items-center gap-3 p-3 rounded-2xl border border-[#222] bg-[#0D0D0D] text-left hover:bg-[#141414] hover:border-[#333] transition-all active:scale-[0.98] group"
    >
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-lg"
        style={{ background: roomGradient(displayName) }}
      >
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-white truncate flex items-center gap-1.5">
            <span>{displayName}</span>
            {memberCount !== null && (
              <span className="text-[10px] font-normal text-[#555] flex items-center gap-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                  <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
                </svg>
                {memberCount}
              </span>
            )}
          </p>
          {preview && (
            <span className="text-[10px] text-[#555] shrink-0 font-medium">
              {formatTime(preview.timestamp)}
            </span>
          )}
        </div>
        <p className="text-xs text-[#666] truncate mt-0.5 flex items-center gap-1">
          {preview ? (
            <>
              <span className={`${preview.senderUid === user?.uid ? 'text-[#007AFF]' : 'text-[#00FF88]'} font-medium`}>
                {preview.senderUid === user?.uid ? 'You' : preview.senderName}
              </span>
              <span className="text-[#444]">&middot;</span>
              <span>{preview.text}</span>
            </>
          ) : (
            <span className="text-[#555] italic">No messages yet</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-[#333] hover:text-red-400 p-1 rounded-lg hover:bg-red-400/5 transition-all opacity-0 group-hover:opacity-100"
          title="Remove room"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c-.84 0-1.673.025-2.5.075V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25v.325C11.673 4.025 10.84 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.42.06a.75.75 0 0 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
          </svg>
        </button>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#333] group-hover:text-[#555] transition-colors shrink-0">
          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
        </svg>
      </div>
    </button>
  );
}
