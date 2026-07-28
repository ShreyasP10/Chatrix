import { useEffect, useCallback, useRef } from 'react';
import {
  doc,
  onSnapshot,
  collection,
  query,
  orderBy,
  setDoc,
  deleteDoc,
  serverTimestamp,
  addDoc,
  getDoc,
  getDocs,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useStore } from '../store/useStore';
import type { CallParticipant, CallInvitation } from '../types';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function setOpusBitrate(sdp: string, bitrate: number = 64000): string {
  return sdp.replace(/a=fmtp:111 (.*)\r\n/g, (match, params) => {
    if (params.includes('maxaveragebitrate')) return match;
    return `a=fmtp:111 ${params};maxaveragebitrate=${bitrate}\r\n`;
  });
}

export function useVoiceCall(roomCode: string | undefined) {
  const {
    user,
    callState,
    setCallState,
    callParticipants,
    setCallParticipants,
    inCall,
    setInCall,
    micEnabled,
    setMicEnabled,
    setCallInvitations,
  } = useStore();
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const unsubsRef = useRef<Map<string, () => void>>(new Map());
  const connectingRef = useRef(false);

  // Listen for call state changes
  useEffect(() => {
    if (!roomCode) return;
    const callRef = doc(db, 'rooms', roomCode, 'calls', 'current');
    const unsub = onSnapshot(callRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.active) {
          setCallState({
            active: data.active,
            initiatorUid: data.initiatorUid,
            initiatorName: data.initiatorName,
            startTime: data.startTime?.toMillis() ?? Date.now(),
            room: `room-${roomCode}`,
            participantCount: data.participantCount ?? 0,
          });
        } else {
          setCallState(null);
        }
      } else {
        setCallState(null);
      }
    });
    return unsub;
  }, [roomCode, setCallState]);

  // Listen for participants
  useEffect(() => {
    if (!roomCode) return;
    const participantsRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'participants');
    const q = query(participantsRef, orderBy('joinedAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: CallParticipant[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          uid: d.id,
          name: data.name,
          muted: data.muted ?? false,
          joinedAt: data.joinedAt?.toMillis() ?? Date.now(),
        });
      });
      setCallParticipants(list);
    });
    return unsub;
  }, [roomCode, setCallParticipants]);

  // Listen for invitations to me
  useEffect(() => {
    if (!roomCode || !user) return;
    const invitesRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'invitations');
    const unsub = onSnapshot(query(invitesRef), (snap) => {
      const invites: CallInvitation[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.targetUid === user.uid) {
          invites.push({
            inviterUid: data.inviterUid,
            inviterName: data.inviterName,
            timestamp: data.timestamp?.toMillis() ?? Date.now(),
          });
        }
      });
      setCallInvitations(invites);
    });
    return unsub;
  }, [roomCode, user, setCallInvitations]);

  // Listen for incoming offers when in call
  useEffect(() => {
    if (!roomCode || !user || !inCall || !localStreamRef.current) return;

    const p2pRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'p2p');
    const unsub = onSnapshot(p2pRef, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== 'added' && change.type !== 'modified') return;
        const data = change.doc.data();
        if (!data || !data.offer) return;

        const uidA = data.uidA;
        const uidB = data.uidB;
        const otherUid = uidA === user.uid ? uidB : uidA;
        if (!otherUid || otherUid === user.uid) return;

        // If we already have a peer connection, skip
        if (peersRef.current.has(otherUid)) return;

        // Rule: higher UID waits for offer, lower UID creates offer.
        // If we are the higher UID and there's an offer from the lower UID, answer it.
        if (user.uid > otherUid && data.offer && !data.answer) {
          handleOffer(otherUid, data.offer, change.doc.id);
        }
      });
    });

    return () => unsub();
  }, [roomCode, user, inCall]);

  const createPeerConnection = useCallback(
    (targetUid: string): RTCPeerConnection | null => {
      if (!roomCode || !user || !localStreamRef.current) return null;
      if (peersRef.current.has(targetUid)) return peersRef.current.get(targetUid)!;

      const stream = localStreamRef.current;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      pc.onicecandidate = (e) => {
        if (e.candidate && roomCode && user) {
          const pairId = getPairId(user.uid, targetUid);
          addDoc(
            collection(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId, 'candidates'),
            {
              from: user.uid,
              to: targetUid,
              candidate: JSON.stringify(e.candidate),
            }
          ).catch(() => {});
        }
      };

      pc.ontrack = (e) => {
        if (!e.streams[0]) return;
        let audioEl = remoteAudioRef.current.get(targetUid);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.hidden = true;
          document.body.appendChild(audioEl);
          remoteAudioRef.current.set(targetUid, audioEl);
        }
        audioEl.srcObject = e.streams[0];
        audioEl.play().catch(() => {});
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          cleanupPeer(targetUid);
        }
      };

      peersRef.current.set(targetUid, pc);
      return pc;
    },
    [roomCode, user]
  );

  const cleanupPeer = useCallback((targetUid: string) => {
    const pc = peersRef.current.get(targetUid);
    if (pc) {
      pc.close();
      peersRef.current.delete(targetUid);
    }
    const audioEl = remoteAudioRef.current.get(targetUid);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
      remoteAudioRef.current.delete(targetUid);
    }
    const unsub = unsubsRef.current.get(targetUid);
    if (unsub) {
      unsub();
      unsubsRef.current.delete(targetUid);
    }
  }, []);

  const handleOffer = useCallback(
    async (fromUid: string, offerSdp: string, _pairId?: string) => {
      if (!roomCode || !user || !localStreamRef.current) return;
      if (peersRef.current.has(fromUid)) return;

      const pc = createPeerConnection(fromUid);
      if (!pc) return;

      const pairId = _pairId || getPairId(user.uid, fromUid);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSdp)));
        const answer = await pc.createAnswer();
        answer.sdp = setOpusBitrate(answer.sdp!);
        await pc.setLocalDescription(answer);

        const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);
        await setDoc(pairRef, { answer: JSON.stringify(pc.localDescription) }, { merge: true });

        listenForCandidates(fromUid, pairId, pc);
      } catch {}
    },
    [roomCode, user, createPeerConnection]
  );

  const connectToPeer = useCallback(
    async (targetUid: string) => {
      if (!roomCode || !user || !localStreamRef.current) return;
      if (peersRef.current.has(targetUid) || targetUid === user.uid) return;

      // Lower UID creates offer; if we're higher UID, wait
      if (user.uid > targetUid) return;

      const pc = createPeerConnection(targetUid);
      if (!pc) return;

      const pairId = getPairId(user.uid, targetUid);
      const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);

      try {
        const offer = await pc.createOffer();
        offer.sdp = setOpusBitrate(offer.sdp!);
        await pc.setLocalDescription(offer);
        await setDoc(pairRef, {
          uidA: user.uid,
          uidB: targetUid,
          offer: JSON.stringify(pc.localDescription),
          answer: null,
        });

        // Listen for answer
        const unsub = onSnapshot(pairRef, (snap) => {
          if (!snap.exists()) return;
          const data = snap.data();
          if (data.answer && pc.currentRemoteDescription === null) {
            try {
              pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));
            } catch {}
          }
        });
        unsubsRef.current.set(targetUid, unsub);

        listenForCandidates(targetUid, pairId, pc);
      } catch {}
    },
    [roomCode, user, createPeerConnection]
  );

  function listenForCandidates(fromUid: string, pairId: string, pc: RTCPeerConnection) {
    if (!roomCode) return;
    const candidatesRef = collection(
      db, 'rooms', roomCode!, 'calls', 'current', 'p2p', pairId, 'candidates'
    );
    const unsub = onSnapshot(candidatesRef, (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const data = change.doc.data();
        if (data.from !== fromUid) continue;
        try {
          pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate)));
        } catch {}
      }
    });
    // Store cleanup alongside existing unsub (don't override)
    const existing = unsubsRef.current.get(fromUid);
    if (existing) {
      const old = existing;
      unsubsRef.current.set(fromUid, () => { old(); unsub(); });
    } else {
      unsubsRef.current.set(fromUid, unsub);
    }
  }

  // Connect to existing participants when joining or when new participants appear
  useEffect(() => {
    if (!inCall || !roomCode || !user) return;
    const existing = callParticipants.filter((p) => p.uid !== user.uid);
    for (const p of existing) {
      if (!peersRef.current.has(p.uid)) {
        connectToPeer(p.uid);
      }
    }
  }, [inCall, roomCode, user, callParticipants, connectToPeer]);

  const joinCall = useCallback(async () => {
    if (!roomCode || !user || connectingRef.current) return;
    connectingRef.current = true;

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 48000,
            channelCount: 1,
          },
        });
      } catch {
        connectingRef.current = false;
        return;
      }
      localStreamRef.current = stream;

      const callRef = doc(db, 'rooms', roomCode, 'calls', 'current');
      const callSnap = await getDoc(callRef);
      if (!callSnap.exists() || !callSnap.data()?.active) {
        await setDoc(callRef, {
          active: true,
          initiatorUid: user.uid,
          initiatorName: user.name,
          startTime: serverTimestamp(),
          participantCount: 0,
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      await setDoc(
        doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', user.uid),
        {
          name: user.name,
          muted: !micEnabled,
          joinedAt: serverTimestamp(),
        }
      );

      setInCall(true);
    } finally {
      connectingRef.current = false;
    }
  }, [roomCode, user, micEnabled, setInCall]);

  const leaveCall = useCallback(async () => {
    for (const [uid] of peersRef.current) {
      cleanupPeer(uid);
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    for (const [, audioEl] of remoteAudioRef.current) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    }
    remoteAudioRef.current.clear();

    setInCall(false);
    setMicEnabled(true);

    if (!roomCode || !user) return;

    await deleteParticipantDoc(roomCode, user.uid);

    const remainingSnap = await getDocs(
      collection(db, 'rooms', roomCode, 'calls', 'current', 'participants')
    );
    if (remainingSnap.empty) {
      await deleteDoc(doc(db, 'rooms', roomCode, 'calls', 'current')).catch(() => {});
    }
  }, [roomCode, user, cleanupPeer, setInCall, setMicEnabled]);

  const toggleMute = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || !roomCode || !user) return;
    const enabled = !stream.getAudioTracks()[0].enabled;
    stream.getAudioTracks().forEach((t) => (t.enabled = enabled));
    setMicEnabled(enabled);
    await setDoc(
      doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', user.uid),
      { muted: !enabled },
      { merge: true }
    );
  }, [roomCode, user, setMicEnabled]);

  const inviteMember = useCallback(
    async (targetUid: string, targetName: string) => {
      if (!roomCode || !user) return;
      try {
        await addDoc(
          collection(db, 'rooms', roomCode, 'calls', 'current', 'invitations'),
          {
            targetUid,
            targetName,
            inviterUid: user.uid,
            inviterName: user.name,
            timestamp: serverTimestamp(),
          }
        );
      } catch {}
    },
    [roomCode, user]
  );

  const dismissInvitation = useCallback(() => {
    setCallInvitations([]);
  }, [setCallInvitations]);

  // Full cleanup on unmount
  useEffect(() => {
    return () => {
      for (const [uid] of peersRef.current) {
        cleanupPeer(uid);
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      for (const [, audioEl] of remoteAudioRef.current) {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      }
      remoteAudioRef.current.clear();
      setInCall(false);
    };
  }, [cleanupPeer, setInCall]);

  return {
    callState,
    inCall,
    callParticipants,
    joinCall,
    leaveCall,
    toggleMute,
    micEnabled,
    inviteMember,
    dismissInvitation,
  };
}

function getPairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

async function deleteParticipantDoc(roomCode: string, uid: string) {
  try {
    await deleteDoc(doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', uid));
  } catch {}
}
