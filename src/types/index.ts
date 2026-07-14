export interface UserProfile {
  uid: string;
  name: string;
  createdAt: number;
}

export interface JoinedRoom {
  code: string;
  joinedAt: number;
  lastReadTimestamp: number | null;
}

export interface ReplyTo {
  messageId: string;
  senderName: string;
  senderUid: string;
  text: string;
}

export interface EncryptedPayload {
  text: string;
  type?: 'text' | 'image' | 'gif';
  replyTo?: { messageId: string; senderName: string; text: string };
}

export interface DecryptedMessage {
  id: string;
  senderUid: string;
  senderName: string;
  text: string;
  type?: 'text' | 'image' | 'gif';
  replyTo?: ReplyTo;
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string[]>;
  timestamp: number;
}

export interface FirestoreUser {
  name: string;
  createdAt: object;
  lastSeen: object;
}

export interface FirestoreRoom {
  createdAt: object;
  createdBy?: string;
}

export interface FirestoreMessage {
  senderUid: string;
  senderName: string;
  ciphertext: string;
  iv: string;
  timestamp: object;
  replyToUid?: string;
  mentionedUids?: string[];
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string[]>;
}

export interface FirestoreToken {
  token: string;
  platform: string;
  createdAt: object;
  lastUsed: object;
}

export interface FirestoreMember {
  joinedAt: object;
  name: string;
}

export interface TypingUser {
  uid: string;
  name: string;
  timestamp: number;
}
