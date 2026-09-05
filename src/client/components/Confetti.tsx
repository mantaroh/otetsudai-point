import { useEffect, useState } from "react";

/**
 * 台帳が満了したときの紙吹雪。
 * 紙のシール帳で最後の1枚を貼る瞬間の気持ちよさを、ここで返している。
 */
const PIECES = ["🎉", "⭐", "✨", "🎊", "🌟"];

export function Confetti({ onDone }: { onDone?: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 36 }, (_, index) => ({
      id: index,
      emoji: PIECES[index % PIECES.length]!,
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      duration: 1.8 + Math.random() * 1.2,
      size: 18 + Math.random() * 22,
    })),
  );

  useEffect(() => {
    const timer = setTimeout(() => onDone?.(), 3200);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden>
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="absolute animate-fall"
          style={{
            left: `${piece.left}%`,
            fontSize: `${piece.size}px`,
            animationDelay: `${piece.delay}s`,
            animationDuration: `${piece.duration}s`,
          }}
        >
          {piece.emoji}
        </span>
      ))}
    </div>
  );
}
