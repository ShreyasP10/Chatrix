import { collection, deleteDoc, doc, getDocs } from 'firebase/firestore';
import { db } from './firebase';

export async function deleteRoomData(code: string) {
  try {
    const snap = await getDocs(collection(db, 'rooms', code, 'messages'));
    for (const d of snap.docs) {
      await deleteDoc(d.ref).catch(() => {});
    }
    const members = await getDocs(collection(db, 'rooms', code, 'members'));
    for (const d of members.docs) {
      await deleteDoc(d.ref).catch(() => {});
    }
    const typing = await getDocs(collection(db, 'rooms', code, 'typing'));
    for (const d of typing.docs) {
      await deleteDoc(d.ref).catch(() => {});
    }
    await deleteDoc(doc(db, 'rooms', code, 'calls', 'current')).catch(() => {});
    await deleteDoc(doc(db, 'rooms', code)).catch(() => {});
  } catch {}
}
