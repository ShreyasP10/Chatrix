import { useState } from 'react';

const EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊',
  '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😗',
  '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
  '🤔', '🤐', '😐', '😑', '😶', '😏', '😒', '🙄',
  '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷',
  '🤒', '🤕', '🤢', '🤮', '🥴', '😵', '🤯', '🤠',
  '🥳', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
  '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
  '👻', '👽', '🤖', '😺', '😸', '😹', '😻', '😼',
  '🙌', '👏', '👍', '👎', '👊', '✊', '🤛', '🤜',
  '🤞', '✌️', '🤟', '🤘', '👌', '❤️', '🧡', '💛',
  '💚', '💙', '💜', '🖤', '💔', '💕', '💞', '💗',
  '💖', '✨', '🔥', '⭐', '🎉', '🎊', '🎈', '💯',
];

interface EmojiPickerProps {
  onEmoji: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ onEmoji, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const filtered = search
    ? EMOJIS.filter((e) => e.includes(search))
    : EMOJIS;

  return (
    <div className="absolute bottom-20 left-4 right-4 max-h-64 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#333]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="flex-1 bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-1.5 outline-none border border-[#333]"
          autoFocus
        />
        <button onClick={onClose} className="text-[#666] hover:text-white text-sm">✕</button>
      </div>
      <div className="overflow-y-auto max-h-48 p-2 grid grid-cols-8 gap-1">
        {filtered.map((emoji) => (
          <button
            key={emoji}
            onClick={() => { onEmoji(emoji); onClose(); }}
            className="w-9 h-9 flex items-center justify-center text-lg hover:bg-[#333] rounded-lg transition-colors"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
