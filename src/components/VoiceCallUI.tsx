import { useState } from 'react';
import type { CallState, CallParticipant, CallInvitation } from '../types';
import InviteToCall from './InviteToCall';

interface Props {
  roomCode: string;
  callState: CallState | null;
  inCall: boolean;
  callParticipants: CallParticipant[];
  micEnabled: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onInvite: (uid: string, name: string) => Promise<void>;
  invitations: CallInvitation[];
  onDismissInvitation: () => void;
}

export default function VoiceCallUI({
  roomCode,
  callState,
  inCall,
  callParticipants,
  micEnabled,
  onJoin,
  onLeave,
  onToggleMute,
  onInvite,
  invitations,
  onDismissInvitation,
}: Props) {
  const [showInvite, setShowInvite] = useState(false);

  if (!callState || !callState.active) return null;

  // Not in call yet – show join banner
  if (!inCall) {
    return (
      <>
        <CallInvitationBanner
          callState={callState}
          invitations={invitations}
          onJoin={onJoin}
          onDismiss={onDismissInvitation}
        />
        {showInvite && (
          <InviteToCall
            roomCode={roomCode}
            onInvite={onInvite}
            onClose={() => setShowInvite(false)}
          />
        )}
      </>
    );
  }

  // In call – show Discord-style bar
  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0D0D0D] border-t border-[#222] backdrop-blur-md">
        <div className="max-w-md md:max-w-lg lg:max-w-xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {callParticipants.map((p) => (
                  <div key={p.uid} className="relative">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ring-2 ring-offset-1 ring-offset-[#0D0D0D] ${
                        !p.muted ? 'ring-[#00FF88]' : 'ring-[#333]'
                      }`}
                      style={{ backgroundColor: `hsl(${hashStr(p.name)}, 55%, 45%)` }}
                      title={`${p.name}${p.muted ? ' (muted)' : ''}`}
                    >
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    {p.muted && (
                      <svg className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 text-red-400 bg-[#0D0D0D] rounded-full" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M10 3.5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0V4.25A.75.75 0 0 1 10 3.5Z"/>
                        <path d="M5.5 9.5a4.5 4.5 0 0 1 9 0v3.5a.75.75 0 0 1-1.5 0V9.5a3 3 0 1 0-6 0v3.5a.75.75 0 0 1-1.5 0V9.5Z"/>
                        <path d="M4.22 4.22a.75.75 0 0 1 1.06 0l12 12a.75.75 0 1 1-1.06 1.06l-12-12a.75.75 0 0 1 0-1.06Z"/>
                      </svg>
                    )}
                  </div>
                ))}
              </div>
              <span className="text-xs text-[#555] ml-1 shrink-0">
                {callParticipants.length} in call
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowInvite(!showInvite)}
                className="text-[#555] hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5"
                title="Invite member"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M10.362 1.093a.75.75 0 0 0-.724 0l-8.5 4.685a.75.75 0 0 0 0 1.294l8.5 4.685a.75.75 0 0 0 .724 0l8.5-4.685a.75.75 0 0 0 0-1.294l-8.5-4.685Z" />
                  <path d="M2.287 7.5 1.09 8.22a.75.75 0 0 0 0 1.294l8.5 4.685a.75.75 0 0 0 .724 0l8.5-4.685a.75.75 0 0 0 0-1.294L17.713 7.5 10 12.06 2.287 7.5Z" />
                  <path d="M2.287 12 1.09 12.72a.75.75 0 0 0 0 1.294l8.5 4.685a.75.75 0 0 0 .724 0l8.5-4.685a.75.75 0 0 0 0-1.294L17.713 12 10 16.56 2.287 12Z" />
                </svg>
              </button>

              <button
                onClick={onToggleMute}
                className={`p-2 rounded-lg transition-all ${
                  micEnabled
                    ? 'text-white hover:bg-white/10'
                    : 'text-red-400 bg-red-400/10 hover:bg-red-400/20'
                }`}
                title={micEnabled ? 'Mute' : 'Unmute'}
              >
                {micEnabled ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                    <path d="M10 1a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                    <path d="M5 9a.75.75 0 0 1 .75.75 4.25 4.25 0 0 0 8.5 0A.75.75 0 0 1 15 9.75a5.75 5.75 0 0 1-5 5.698V17a.75.75 0 0 1-1.5 0v-1.552A5.75 5.75 0 0 1 4.25 9.75A.75.75 0 0 1 5 9Z" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                    <path d="M10 1a3 3 0 0 0-3 3v4.5a3 3 0 0 0 4.146 2.736l-1.25-1.25A1.5 1.5 0 0 1 8.5 8.5V4a1.5 1.5 0 0 1 3 0v.643l1.5 1.5V4a3 3 0 0 0-3-3Z" />
                    <path d="M15.157 10.757a5.75 5.75 0 0 1-1.03 2.217l-1.032-1.032a4.25 4.25 0 0 0 .605-1.185.75.75 0 1 1 1.457.05Z" />
                    <path d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l4.22 4.22V9a3 3 0 0 0 4.134 2.806l1.06 1.06A4.5 4.5 0 0 1 5.5 9.75a.75.75 0 0 0-1.5 0 6 6 0 0 0 5.25 5.948V17a.75.75 0 0 0 1.5 0v-1.302a5.99 5.99 0 0 0 2.234-.89l2.736 2.736a.75.75 0 1 0 1.06-1.06L3.28 2.22Z" />
                  </svg>
                )}
              </button>

              <button
                onClick={onLeave}
                className="text-red-400 hover:text-white bg-red-400/10 hover:bg-red-500/20 p-2 rounded-lg transition-all"
                title="Leave call"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.716 3.223a1.5 1.5 0 0 1-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 0 0 6.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 0 1 1.767-1.052l3.223.716A1.5 1.5 0 0 1 18 15.352V16.5a1.5 1.5 0 0 1-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 0 1 2.43 8.326 13.019 13.019 0 0 1 2 5V3.5Z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {showInvite && (
        <InviteToCall
          roomCode={roomCode}
          onInvite={onInvite}
          onClose={() => setShowInvite(false)}
        />
      )}
    </>
  );
}

function CallInvitationBanner({
  callState,
  invitations,
  onJoin,
  onDismiss,
}: {
  callState: { initiatorName: string };
  invitations: { inviterName: string }[];
  onJoin: () => void;
  onDismiss: () => void;
}) {
  const latestInvite = invitations[invitations.length - 1];
  const label = latestInvite
    ? `${latestInvite.inviterName} invited you to call`
    : `${callState.initiatorName} started a voice call`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0D0D0D] border-t border-[#222] backdrop-blur-md animate-slide-up">
      <div className="max-w-md md:max-w-lg lg:max-w-xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-full bg-[#00FF88]/20 flex items-center justify-center shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#00FF88]">
              <path d="M10 1a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
              <path d="M5 9a.75.75 0 0 1 .75.75 4.25 4.25 0 0 0 8.5 0A.75.75 0 0 1 15 9.75a5.75 5.75 0 0 1-5 5.698V17a.75.75 0 0 1-1.5 0v-1.552A5.75 5.75 0 0 1 4.25 9.75A.75.75 0 0 1 5 9Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm text-white font-medium truncate">{label}</p>
            <p className="text-xs text-[#555]">Tap to join</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onDismiss}
            className="text-xs text-[#555] hover:text-white px-3 py-1.5 rounded-lg hover:bg-white/5 transition-all"
          >
            Dismiss
          </button>
          <button
            onClick={onJoin}
            className="text-xs font-medium text-black bg-[#00FF88] px-4 py-1.5 rounded-lg hover:bg-[#00DD77] transition-all"
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}

function hashStr(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}
