import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp,
  getDocs,
  startAfter,
  doc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { deriveKey, encrypt, decrypt } from '../lib/crypto';
import { useStore } from '../store/useStore';
import Avatar from '../components/Avatar';
import type { DecryptedMessage, ReplyTo, TypingUser } from '../types';

const PAGE_SIZE = 50;
const TYPING_TIMEOUT = 2000;

export default function ChatScreen() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, messages, setMessages } = useStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [memberNameMap, setMemberNameMap] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastDocRef = useRef<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!code) return;
    deriveKey(code).then(setCryptoKey);
    // Tell SW this is the active room (suppress notifications for it)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'ACTIVE_ROOM', code });
    }
    return () => {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'ACTIVE_ROOM', code: null });
      }
    };
  }, [code]);

  useEffect(() => {
    if (!code) return;
    const unsub = onSnapshot(doc(db, 'rooms', code), (snap) => {
      if (!snap.exists()) navigate('/', { replace: true });
    });
    return unsub;
  }, [code, navigate]);

  useEffect(() => {
    if (!code) return;
    const q = query(collection(db, 'rooms', code, 'members'));
    const unsub = onSnapshot(q, (snap) => {
      setMemberCount(snap.size);
      const map: Record<string, string> = {};
      snap.forEach((d) => {
        const data = d.data();
        if (data.name) map[data.name.toLowerCase()] = d.id;
      });
      setMemberNameMap(map);
    });
    return unsub;
  }, [code]);

  useEffect(() => {
    if (!code) return;
    const q = query(collection(db, 'rooms', code, 'typing'));
    const unsub = onSnapshot(q, (snap) => {
      const users: TypingUser[] = [];
      const now = Date.now();
      snap.forEach((d) => {
        if (d.id !== user?.uid) {
          const data = d.data();
          const ts = data.timestamp?.toMillis() ?? now;
          if (now - ts < 3000) {
            users.push({ uid: d.id, name: data.name, timestamp: ts });
          }
        }
      });
      setTypingUsers(users);
    });
    return unsub;
  }, [code, user?.uid]);

  useEffect(() => {
    if (!code || !cryptoKey) return;
    setLoading(true);

    const q = query(
      collection(db, 'rooms', code, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(PAGE_SIZE)
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const docs = snap.docs;
        if (docs.length === 0) {
          setMessages([]);
          setLoading(false);
          return;
        }
        lastDocRef.current = docs[docs.length - 1] || null;
        setHasMore(docs.length >= PAGE_SIZE);

        const decrypted = await Promise.all(
          docs.map(async (d) => decryptMessage(d.data(), d.id, cryptoKey))
        );
        setMessages(decrypted.reverse());
        setLoading(false);
      },
      () => setLoading(false)
    );

    return unsub;
  }, [code, cryptoKey, setMessages]);

  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const loadOlder = useCallback(async () => {
    if (!code || !cryptoKey || !lastDocRef.current || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const q = query(
      collection(db, 'rooms', code, 'messages'),
      orderBy('timestamp', 'desc'),
      startAfter(lastDocRef.current),
      limit(PAGE_SIZE)
    );
    const snap = await getDocs(q);
    const docs = snap.docs;
    lastDocRef.current = docs[docs.length - 1] || null;
    setHasMore(docs.length >= PAGE_SIZE);

    const older = await Promise.all(
      docs.map((d) => decryptMessage(d.data(), d.id, cryptoKey))
    );

    setMessages((prev) => [...older.reverse(), ...prev]);
    setLoadingOlder(false);
  }, [code, cryptoKey, hasMore, loadingOlder]);

  const updateTypingStatus = useCallback(
    (text: string) => {
      if (!code || !user) return;
      const typingRef = doc(db, 'rooms', code, 'typing', user.uid);

      if (text.trim().length > 0) {
        setDoc(typingRef, { name: user.name, timestamp: serverTimestamp() });
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          deleteDoc(typingRef);
        }, TYPING_TIMEOUT);
      } else {
        deleteDoc(typingRef);
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }
    },
    [code, user]
  );

  useEffect(() => {
    return () => {
      if (code && user) {
        deleteDoc(doc(db, 'rooms', code, 'typing', user.uid));
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [code, user]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    updateTypingStatus(val);
  };

  const handleReply = (msg: DecryptedMessage) => {
    setReplyTo({
      messageId: msg.id,
      senderName: msg.senderName,
      senderUid: msg.senderUid,
      text: msg.text.slice(0, 80),
    });
    inputRef.current?.focus();
  };

  const cancelReply = () => setReplyTo(null);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !code || !cryptoKey || !user || sending) return;
    setSending(true);
    setInput('');

    const payload: any = { text };
    const msgData: any = {
      senderUid: user.uid,
      senderName: user.name,
      timestamp: serverTimestamp(),
    };

    if (replyTo) {
      payload.replyTo = { messageId: replyTo.messageId, senderName: replyTo.senderName, text: replyTo.text };
      msgData.replyToUid = replyTo.senderUid;
    }

    const mentionedUids = parseMentions(text, memberNameMap);
    if (mentionedUids.length > 0) {
      msgData.mentionedUids = mentionedUids;
    }

    try {
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), cryptoKey);
      msgData.ciphertext = ciphertext;
      msgData.iv = iv;
      await addDoc(collection(db, 'rooms', code, 'messages'), msgData);
      setReplyTo(null);
      updateTypingStatus('');
    } catch {
      setInput(text);
    }
    setSending(false);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  };

  const typingText = typingUsers.length === 0
    ? ''
    : typingUsers.length === 1
      ? `${typingUsers[0].name} is typing...`
      : typingUsers.length === 2
        ? `${typingUsers[0].name} and ${typingUsers[1].name} are typing...`
        : `${typingUsers[0].name} and ${typingUsers.length - 1} others are typing...`;

  return (
    <div className="flex flex-col h-dvh bg-black max-w-md mx-auto">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[#333] shrink-0">
        <button onClick={() => navigate('/')} className="text-[#007AFF] font-medium text-sm shrink-0">
          &larr; Back
        </button>
        <div className="flex-1 text-center min-w-0">
          <h1 className="text-sm font-bold truncate">
            {code ? `Chat #${code}` : 'Chat'}
          </h1>
          {typingText ? (
            <p className="text-xs text-[#00FF88] animate-pulse truncate">{typingText}</p>
          ) : memberCount !== null ? (
            <p className="text-xs text-[#B3B3B3]">{memberCount} member{memberCount !== 1 ? 's' : ''}</p>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
        {loading && (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-[#333] border-t-[#007AFF] rounded-full animate-spin" />
          </div>
        )}

        {hasMore && !loading && messages.length >= PAGE_SIZE && (
          <button
            onClick={loadOlder}
            disabled={loadingOlder}
            className="w-full text-xs text-[#B3B3B3] py-2 hover:text-white transition-colors disabled:opacity-40"
          >
            {loadingOlder ? 'Loading...' : 'Load older messages'}
          </button>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-[#B3B3B3] text-sm">
            No messages yet. Say hello!
          </div>
        )}

        {messages.map((msg) => {
          const isOwn = msg.senderUid === user?.uid;
          return (
            <div key={msg.id} className={`group flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
              <div className={`flex items-center gap-1.5 mb-1 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                {!isOwn && <Avatar name={msg.senderName} size="sm" />}
                <span className="text-xs text-[#B3B3B3]">{msg.senderName}</span>
                <span className="text-[10px] text-[#555]">{formatTime(msg.timestamp)}</span>
              </div>

              {msg.replyTo && (
                <div
                  className={`text-xs px-3 py-1.5 rounded-t-lg border border-[#444] max-w-[75%] mb-0.5 ${
                    isOwn ? 'rounded-bl-lg bg-[#0055BB]/30 mr-9' : 'rounded-br-lg bg-[#222] ml-9'
                  }`}
                >
                  <span className="text-[#00FF88] font-medium">@{msg.replyTo.senderName}</span>
                  <p className="text-[#999] truncate mt-0.5">{msg.replyTo.text}</p>
                </div>
              )}

              <div className={`flex items-end gap-1.5 ${isOwn ? 'flex-row' : 'flex-row-reverse'}`}>
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                    isOwn
                      ? 'bg-[#007AFF] text-white rounded-br-md'
                      : 'bg-[#1C1C1E] text-white rounded-bl-md'
                  }`}
                >
                  <MentionText text={msg.text} />
                </div>
                <button
                  onClick={() => handleReply(msg)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-[#666] hover:text-[#007AFF] text-xs shrink-0"
                  title="Reply"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {replyTo && (
        <div className="px-4 py-2 bg-[#0D0D0D] border-t border-[#333] flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <span className="text-xs text-[#00FF88] font-medium">@{replyTo.senderName}</span>
            <p className="text-xs text-[#666] truncate">{replyTo.text}</p>
          </div>
          <button onClick={cancelReply} className="text-[#666] hover:text-white shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      )}

      <div className="px-4 py-3 border-t border-[#333] shrink-0">
        <div className="flex items-center gap-2 bg-[#1C1C1E] rounded-full px-4 py-2 border border-[#2C2C2E]">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
            placeholder={replyTo ? 'Write a reply...' : 'Message'}
            className="flex-1 bg-transparent text-white placeholder-gray-500 outline-none text-sm"
            maxLength={2000}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending || !cryptoKey}
            className="text-[#007AFF] disabled:opacity-30 transition-opacity"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function parseMentions(text: string, nameMap: Record<string, string>): string[] {
  const uids: string[] = [];
  const seen = new Set<string>();
  const matches = text.matchAll(/@(\S+)/g);
  for (const match of matches) {
    const name = match[1].replace(/[^a-zA-Z0-9_\u0080-\uFFFF\s]/g, '').toLowerCase();
    if (name && nameMap[name] && !seen.has(nameMap[name])) {
      seen.add(nameMap[name]);
      uids.push(nameMap[name]);
    }
  }
  return uids;
}

function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@\w+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^@\w+$/.test(part)
          ? <span key={i} className="text-[#00FF88] font-medium">{part}</span>
          : part
      )}
    </>
  );
}

async function decryptMessage(data: any, id: string, key: CryptoKey): Promise<DecryptedMessage> {
  try {
    const decrypted = await decrypt(data.ciphertext, data.iv, key);
    const parsed = JSON.parse(decrypted);
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName,
      text: parsed.text || parsed,
      replyTo: parsed.replyTo || undefined,
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  } catch {
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName,
      text: '[Decryption failed]',
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  }
}
