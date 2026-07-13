import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  updateDoc,
  serverTimestamp,
  getDocs,
  startAfter,
  doc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { deriveKey, encrypt, decrypt } from '../lib/crypto';
import { swSend } from '../lib/sw';
import { useStore } from '../store/useStore';
import Avatar from '../components/Avatar';
import EmojiPicker from '../components/EmojiPicker';
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [memberList, setMemberList] = useState<{ name: string; uid: string }[]>([]);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastDocRef = useRef<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seenMsgIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!code) return;
    deriveKey(code).then(setCryptoKey);
    // Tell SW this is the active room (suppress notifications for it)
    swSend({ type: 'ACTIVE_ROOM', code });
    return () => { swSend({ type: 'ACTIVE_ROOM', code: null }); };
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
      const list: { name: string; uid: string }[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.name) {
          map[data.name.toLowerCase()] = d.id;
          list.push({ name: data.name, uid: d.id });
        }
      });
      setMemberNameMap(map);
      setMemberList(list);
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
        const isHidden = document.hidden;

        // Forward new messages from others to SW when page is backgrounded
        if (isHidden && user) {
          snap.docChanges().forEach((change) => {
            if (change.type !== 'added') return;
            const id = change.doc.id;
            if (seenMsgIds.current.has(id)) return;
            seenMsgIds.current.add(id);
            const d = change.doc.data();
            if (d.senderUid !== user.uid) {
              swSend({
                type: 'SHOW_NOTIFICATION',
                roomCode: code,
                senderName: d.senderName,
                replyToUid: d.replyToUid || null,
                mentionedUids: d.mentionedUids || [],
              });
            }
          });
        } else {
          docs.forEach((d) => seenMsgIds.current.add(d.id));
        }

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
    const cursor = e.target.selectionStart ?? val.length;
    setInput(val);
    updateTypingStatus(val);

    // Detect @mention
    const textBeforeCursor = val.slice(0, cursor);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
      if (!afterAt.includes(' ')) {
        setMentionQuery(afterAt);
        setMentionStartIndex(lastAtIndex);
        setMentionSelectedIndex(0);
        return;
      }
    }
    setMentionQuery('');
    setMentionStartIndex(-1);
  };

  const selectMention = (name: string) => {
    if (mentionStartIndex === -1) return;
    const before = input.slice(0, mentionStartIndex);
    const cursor = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursor);
    const newVal = before + '@' + name + ' ' + after;
    setInput(newVal);
    setMentionQuery('');
    setMentionStartIndex(-1);
    inputRef.current?.focus();
  };

  const handleReply = (msg: DecryptedMessage) => {
    setEditingId(null);
    setReplyTo({
      messageId: msg.id,
      senderName: msg.senderName,
      senderUid: msg.senderUid,
      text: msg.text.slice(0, 80),
    });
    inputRef.current?.focus();
  };

  const cancelReply = () => { setReplyTo(null); setMentionQuery(''); setMentionStartIndex(-1); };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !code || !cryptoKey || !user || sending) return;
    setSending(true);
    setInput('');

    const payload: any = { text, type: 'text' };
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

      if (editingId) {
        msgData.edited = true;
        await updateDoc(doc(db, 'rooms', code, 'messages', editingId), msgData);
        setEditingId(null);
      } else {
        await addDoc(collection(db, 'rooms', code, 'messages'), msgData);
      }

      setReplyTo(null);
      setMentionQuery('');
      setMentionStartIndex(-1);
      updateTypingStatus('');
    } catch {
      setInput(text);
    }
    setSending(false);
  };

  const handleEdit = (msg: DecryptedMessage) => {
    setEditingId(msg.id);
    setInput(msg.text);
    setReplyTo(null);
    inputRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setInput('');
    setMentionQuery('');
    setMentionStartIndex(-1);
    inputRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const newVal = input.slice(0, start) + emoji + input.slice(end);
    setInput(newVal);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !code || !cryptoKey || !user || sending) return;
    if (!file.type.startsWith('image/')) return;
    setSending(true);

    try {
      let dataUrl = await fileToDataUrl(file);
      if (dataUrl.length > 900_000) {
        dataUrl = await compressImage(dataUrl, 800);
      }
      const payload = { text: dataUrl, type: 'image' };
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), cryptoKey);
      await addDoc(collection(db, 'rooms', code, 'messages'), {
        senderUid: user.uid,
        senderName: user.name,
        ciphertext,
        iv,
        timestamp: serverTimestamp(),
      });
    } catch {}
    setSending(false);
    if (e.target) e.target.value = '';
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
          const isImage = msg.type === 'image';
          return (
            <div key={msg.id} className={`group flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
              <div className={`flex items-center gap-1.5 mb-1 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                {!isOwn && <Avatar name={msg.senderName} size="sm" />}
                <span className="text-xs text-[#B3B3B3]">{msg.senderName}</span>
                <span className="text-[10px] text-[#555]">{formatTime(msg.timestamp)}</span>
                {msg.edited && <span className="text-[10px] text-[#666]">(edited)</span>}
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
                {isImage ? (
                  <div
                    className={`max-w-[75%] rounded-2xl overflow-hidden border border-[#333] ${
                      isOwn ? 'rounded-br-md' : 'rounded-bl-md'
                    }`}
                  >
                    <img
                      src={msg.text}
                      alt="Shared image"
                      className="w-full h-auto max-h-72 object-cover"
                      loading="lazy"
                    />
                  </div>
                ) : (
                  <div
                    className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                      isOwn
                        ? 'bg-[#007AFF] text-white rounded-br-md'
                        : 'bg-[#1C1C1E] text-white rounded-bl-md'
                    }`}
                  >
                    <MentionText text={msg.text} />
                  </div>
                )}
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {isOwn && !isImage && (
                    <button
                      onClick={() => handleEdit(msg)}
                      className="text-[#666] hover:text-[#007AFF] text-xs shrink-0"
                      title="Edit"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                        <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => handleReply(msg)}
                    className="text-[#666] hover:text-[#007AFF] text-xs shrink-0"
                    title="Reply"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {editingId && (
        <div className="px-4 py-2 bg-[#0D0D0D] border-t border-[#333] flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <span className="text-xs text-[#007AFF] font-medium">Editing message</span>
          </div>
          <button onClick={cancelEdit} className="text-[#666] hover:text-white shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      )}

      {replyTo && !editingId && (
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

      <div className="px-4 py-3 border-t border-[#333] shrink-0 relative">
        {mentionStartIndex !== -1 && mentionQuery !== undefined && (
          <MentionDropdown
            query={mentionQuery}
            members={memberList}
            excludeUid={user?.uid}
            selectedIndex={mentionSelectedIndex}
            onSelect={selectMention}
            onIndexChange={setMentionSelectedIndex}
          />
        )}
        {showEmojiPicker && (
          <EmojiPicker
            onEmoji={insertEmoji}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        <div className="flex items-center gap-2 bg-[#1C1C1E] rounded-full px-4 py-2 border border-[#2C2C2E]">
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="text-[#666] hover:text-white shrink-0 transition-colors"
            title="Emoji"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm-2.625 6c-.54 0-.828.419-.936.634a1.96 1.96 0 0 0-.189.866c0 .298.059.605.189.866.108.215.395.634.936.634.54 0 .828-.419.936-.634.13-.26.189-.568.189-.866 0-.298-.059-.605-.189-.866-.108-.215-.395-.634-.936-.634Zm4.314.634c.108-.215.395-.634.936-.634.54 0 .828.419.936.634.13.26.189.568.189.866 0 .298-.059.605-.189.866-.108.215-.395.634-.936.634-.54 0-.828-.419-.936-.634a1.96 1.96 0 0 1-.189-.866c0-.298.059-.605.189-.866Zm-4.34 7.964a.75.75 0 0 1-1.061-1.06 5.236 5.236 0 0 1 3.73-1.538 5.236 5.236 0 0 1 3.695 1.538.75.75 0 1 1-1.061 1.06 3.736 3.736 0 0 0-2.639-1.098 3.736 3.736 0 0 0-2.664 1.098Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-[#666] hover:text-white shrink-0 transition-colors"
            title="Attach image"
            disabled={sending}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 0 1 2.25-2.25h16.5A2.25 2.25 0 0 1 22.5 6v12a2.25 2.25 0 0 1-2.25 2.25H3.75A2.25 2.25 0 0 1 1.5 18V6ZM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0 0 21 18v-1.94l-2.69-2.689a1.5 1.5 0 0 0-2.12 0l-.88.879.97.97a.75.75 0 1 1-1.06 1.06l-5.16-5.159a1.5 1.5 0 0 0-2.12 0L3 16.061Zm10.125-7.81a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Z" clipRule="evenodd" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (mentionStartIndex !== -1) {
                const filtered = memberList.filter(
                  (m) => m.uid !== user?.uid && m.name.toLowerCase().includes(mentionQuery.toLowerCase())
                );
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionSelectedIndex((prev) => Math.max(prev - 1, 0));
                  return;
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && filtered.length > 0) {
                  e.preventDefault();
                  selectMention(filtered[mentionSelectedIndex].name);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery('');
                  setMentionStartIndex(-1);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={editingId ? 'Edit message...' : replyTo ? 'Write a reply...' : 'Message'}
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
      type: parsed.type || 'text',
      replyTo: parsed.replyTo || undefined,
      edited: data.edited || false,
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

function MentionDropdown({
  query,
  members,
  excludeUid,
  selectedIndex,
  onSelect,
  onIndexChange,
}: {
  query: string;
  members: { name: string; uid: string }[];
  excludeUid?: string | null;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onIndexChange: (idx: number) => void;
}) {
  const filtered = members.filter(
    (m) => m.uid !== excludeUid && m.name.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      onIndexChange(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex, onIndexChange]);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-20 left-4 right-4 max-h-48 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="overflow-y-auto max-h-48">
        {filtered.map((member, idx) => (
          <button
            key={member.uid}
            onClick={() => onSelect(member.name)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
              idx === selectedIndex ? 'bg-[#007AFF]/20 text-white' : 'text-[#B3B3B3] hover:bg-[#333]'
            }`}
          >
            <Avatar name={member.name} size="sm" />
            <span className="font-medium">@{member.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
