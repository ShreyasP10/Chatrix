# Chatrix — Anonymous Encrypted Group Chat (PWA)

Zero-login, real-time group chat with end-to-end-like encryption. No account creation needed — just pick a name and share a 4-digit room code. Works as a Progressive Web App (installable, offline shell, push notifications).

## Features

- **No authentication** — choose any display name, that's it
- **4-digit room codes** — join by typing a code, create new rooms instantly
- **AES-256-GCM encryption** — messages encrypted client-side with PBKDF2-derived key from room code. Server sees only ciphertext
- **Real-time messaging** — Firestore `onSnapshot` listeners for instant updates
- **File sharing** — share images, PDFs, documents, and other files via encrypted data URLs (end-to-end encrypted like all messages)
- **Image sharing** — compress and share images inline with automatic resize
- **Voice calls** — WebRTC peer-to-peer voice calls with Firestore-based signaling
- **Push notifications** — service worker watches Firestore directly; no Cloud Functions (Blaze) required
- **Reply / @mentions** — reply to specific messages, tag users with `@name`, highlighted in green

- **Emoji picker** — built-in emoji selector with 96 emojis and search
- **Message reactions** — react to messages with emojis
- **Message editing & deletion** — edit or delete your own messages
- **Typing indicators** — see who's typing in real-time
- **Avatars** — auto-generated initials with hash-based background colors
- **Room history** — infinite scroll pagination, all previous messages loaded on enter
- **Room name editing** — rename rooms inline with real-time sync
- **Member list** — view all members and their online status with search/filter
- **Pure black UI** — dark, distraction-free ChatGPT-style interface
- **Installable PWA** — add to home screen, standalone mode
- **Vercel Analytics** — privacy-friendly analytics

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS v4 |
| Database | Firebase Firestore (free tier) |
| Push | FCM + Firestore listeners in Service Worker |
| Encryption | Web Crypto API (PBKDF2 + AES-256-GCM) |
| Local DB | Dexie.js (IndexedDB wrapper) |
| State | Zustand |
| PWA | vite-plugin-pwa (injectManifest) |
| Routing | React Router v6 |
| Voice Calls | WebRTC (peer-to-peer) |
| Analytics | Vercel Analytics |
| Linting | oxlint |

## Prerequisites

- Node.js 18+
- A Firebase project with Firestore enabled (Spark plan is sufficient)

## Setup

### 1. Clone and install

```bash
git clone <repo-url> chatrix
cd chatrix
npm install
```

### 2. Firebase Console Setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a new project (or use existing)
3. **Firestore Database** → Create → Start in **test mode** → choose a region
4. **Project Settings** → General → **Add app** → Web → copy the config values
5. **Project Settings** → Cloud Messaging → **Web Push certificates** → **Generate** → copy the VAPID key

### 3. Environment Variables

Copy `.env` (already created) or create from scratch:

```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_FIREBASE_VAPID_KEY=your_vapid_public_key
```

### 4. Firestore Security Rules

Firestore → Rules → paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> **Note:** The app uses client-side encryption so message content is never exposed to the server. These permissive rules are acceptable for the encryption model. For production, consider restricting by path.

### 5. Ad-blocker note

Some browser extensions block Firestore long-polling connections. If you see `ERR_BLOCKED_BY_CLIENT` in the console, add `localhost` and `firestore.googleapis.com` to your ad blocker's allowlist, or use `initializeFirestore` with `experimentalAutoDetectLongPolling: true` (already configured).

### 6. Run

```bash
npm run dev        # Development server (http://localhost:5173)
npm run build      # Production build → dist/
npm run preview    # Preview production build
```

## Project Structure

```
src/
├── main.tsx                 # Entry point
├── App.tsx                  # Router + auth gate + SW sync
├── index.css                # Tailwind import + base styles
├── sw.ts                    # Service Worker (notifications + Firestore watcher)
├── vite-env.d.ts            # Env type declarations
├── types/
│   └── index.ts             # All TypeScript interfaces
├── lib/
│   ├── firebase.ts          # Firebase config + initialization
│   ├── db.ts                # Dexie.js IndexedDB setup
│   ├── crypto.ts            # PBKDF2 key derivation + AES-256-GCM
│   └── sw.ts                # SW communication helper
├── store/
│   └── useStore.ts          # Zustand global state
├── components/
│   ├── Avatar.tsx           # Initials avatar with hash color
│   ├── EmojiPicker.tsx      # Emoji selector popup with search
│   ├── InviteToCall.tsx     # Modal to invite room members to voice call
│   ├── NameModal.tsx        # First-time name registration modal
│   ├── OtpInput.tsx         # 4-box OTP-style room code input
│   └── VoiceCallUI.tsx      # Discord-style voice call UI
├── pages/
│   ├── Dashboard.tsx        # Room code entry, join/create, room list
│   └── ChatScreen.tsx       # Real-time chat with messages, typing, replies
├── hooks/
│   ├── useInstallPrompt.ts  # beforeinstallprompt event handler
│   └── useVoiceCall.ts      # WebRTC peer-to-peer voice call logic
├── functions/               # Firebase Cloud Functions
│   └── src/
│       └── index.ts         # LiveKit token server, FCM call notifications
└── scripts/                 # Utility scripts
    ├── add-seq.mjs          # Add seq field to Firestore messages
    ├── generate-icons.cjs   # Generate PWA icon PNGs
    └── import-chats.mjs     # Import chat history from file
```

## Data Model (Firestore)

### `users/{uid}`
```json
{
  "name": "Alice",
  "createdAt": "<timestamp>",
  "lastSeen": "<timestamp>"
}
```

### `rooms/{code}`
```json
{
  "name": "Room 1234",
  "createdAt": "<timestamp>",
  "createdBy": "<uid>"
}
```

### `rooms/{code}/messages/{messageId}`
```json
{
  "senderUid": "<uid>",
  "senderName": "Alice",
  "ciphertext": "<base64>",
  "iv": "<base64>",
  "timestamp": "<serverTimestamp>",
  "seq": "<number>",
  "replyToUid": "<uid>",
  "mentionedUids": ["<uid>", ...],
  "edited": true,
  "deleted": true,
  "reactions": {
    "🔥": ["<uid1>", "<uid2>"]
  }
}
```

### `rooms/{code}/members/{uid}`
```json
{
  "joinedAt": "<timestamp>",
  "name": "Alice",
  "online": true,
  "lastSeen": "<timestamp>"
}
```

### `users/{uid}/tokens/{tokenId}`
```json
{
  "token": "<fcm_token>",
  "platform": "web",
  "createdAt": "<timestamp>",
  "lastUsed": "<timestamp>"
}
```

### `rooms/{code}/typing/{uid}`
```json
{
  "name": "Alice",
  "timestamp": "<timestamp>"
}
```

## Encryption Details

- **Key derivation**: PBKDF2(SHA-256, 100,000 iterations, salt: `chatwave-salt-2026`)
- **Cipher**: AES-256-GCM with random 12-byte IV per message
- **Message payload**: `JSON.stringify({ text, type?, file?, replyTo? })` — encrypted as a single blob
- **Key lifetime**: Derived on room entry, held in memory only, never persisted
- **File encryption**: Files are read as data URLs, encrypted with the same AES-256-GCM key, and stored inline in Firestore. File metadata (name, size, type) is included in the encrypted payload.
- **Security model**: Room code is the shared secret. Anyone with the code can decrypt all messages in that room. 4-digit code space (9000 possibilities) is acknowledged as a brute-forceable weakness.

## Voice Calls (WebRTC)

- Peer-to-peer voice calls using WebRTC with Google STUN servers
- Firestore-based signaling (offers, answers, ICE candidates)
- Call invitations with accept/decline flow
- Real-time participant list with mute/unmute
- Works without any media server on the free Spark plan

## Push Notifications (Spark Plan)

Chatrix does **not** require Firebase Cloud Functions (Blaze plan). Instead:

1. The **service worker** embeds Firebase Firestore SDK
2. The app sends joined room codes to the SW via `postMessage`
3. The SW sets up `onSnapshot` listeners on each room's messages (last message)
4. When a new message arrives:
   - Not from the current user
   - User is not viewing that room
   - → Shows a notification with the sender name and room code
5. Special handling for **replies** (`replyToUid`) and **@mentions** (`mentionedUids`)
6. FCM push events serve as a fallback mechanism when Cloud Functions are deployed

This approach works on the free Spark plan without any backend server.

## Usage Flow

1. **First visit** → Name modal → enter display name → saved locally + Firestore
2. **Dashboard** → type a 4-digit code → **Join** existing room or **Create** new one
3. **Chat** → send encrypted messages, reply with ↩️, @mention with `@name`, share files/images
4. **Voice calls** → tap the microphone icon in the header to start or join a call
5. **Returning** → room list on dashboard shows recent chats with previews
6. **Notifications** → SW delivers background notifications for new messages

## Limitations

- 4-digit room codes = 9000 possible rooms. Brute-forceable — acknowledged trade-off
- Encryption key derived from room code. Anyone with the code can read all messages
- File sharing limited to ~700KB per file (1MB document limit after base64 encoding)
- Offline message queuing not implemented (future scope)
- iOS push notification support limited by platform PWA restrictions

## Collaborators

- [Shreyas Pawar](https://github.com/ShreyasP10) — Frontend development, UI/UX design,  WebRTC integration
- [Atharva Mahajan](https://github.com/mahajanatharva1042) — Backend Development, Voice call implementation, feature development

## License

MIT
