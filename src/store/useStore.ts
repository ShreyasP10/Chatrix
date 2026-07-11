import { create } from 'zustand';
import type { UserProfile, DecryptedMessage, JoinedRoom } from '../types';

interface AppState {
  user: UserProfile | null;
  setUser: (user: UserProfile | null) => void;
  currentRoom: string | null;
  setCurrentRoom: (code: string | null) => void;
  messages: DecryptedMessage[];
  setMessages: (messages: DecryptedMessage[] | ((prev: DecryptedMessage[]) => DecryptedMessage[])) => void;
  joinedRooms: JoinedRoom[];
  setJoinedRooms: (rooms: JoinedRoom[]) => void;
  addJoinedRoom: (room: JoinedRoom) => void;
}

export const useStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  currentRoom: null,
  setCurrentRoom: (code) => set({ currentRoom: code }),
  messages: [],
  setMessages: (messages) =>
    set((state) => ({
      messages: typeof messages === 'function' ? messages(state.messages) : messages,
    })),
  joinedRooms: [],
  setJoinedRooms: (rooms) => set({ joinedRooms: rooms }),
  addJoinedRoom: (room) =>
    set((state) => {
      const exists = state.joinedRooms.find((r) => r.code === room.code);
      if (exists) return state;
      return { joinedRooms: [...state.joinedRooms, room] };
    }),
}));
