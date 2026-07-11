import Dexie, { type Table } from 'dexie';
import type { UserProfile, JoinedRoom } from '../types';

class ChatrixDB extends Dexie {
  userProfile!: Table<UserProfile, string>;
  joinedRooms!: Table<JoinedRoom, string>;

  constructor() {
    super('ChatrixDB');
    this.version(1).stores({
      userProfile: 'uid',
      joinedRooms: 'code',
    });
  }
}

export const localDB = new ChatrixDB();
