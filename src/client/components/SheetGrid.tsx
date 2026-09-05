import { useRef } from "react";
import type { Sheet } from "../../shared/types";

/**
 * 台帳のグリッド。紙のシール台帳をそのまま画面に置くのが狙い。
 *
 * 空きマスは薄い丸で「ここに貼れる」ことを示し、
 * 貼られたマスにはそのお手伝いの絵文字が乗る。
 * 何をして貯めたかが台帳を見ただけで分かるのは、紙にはなかった良さ。
 */

export interface PendingSticker {
  key: string;
  art: string | null;
}

function columnsFor(capacity: number): number {
  if (capacity % 6 === 0) return 6;
  if (capacity % 5 === 0) return 5;
  if (capacity % 4 === 0) return 4;
  return 5;
}

export function SheetGrid({
  sheet,
  accent,
  pending = [],
}: {
  sheet: Sheet;
  accent: string;
  /** 通信中の楽観表示。押した瞬間に貼られて見えることが大事。 */
  pending?: PendingSticker[];
}) {
  // この画面を開いたあとに貼られたシールだけをアニメーションさせる
  const openedAt = useRef(Date.now());
  const columns = columnsFor(sheet.capacity);

  const cells: Array<{ key: string; art: string | null; fresh: boolean } | null> = [];
  for (const sticker of sheet.stickers) {
    cells.push({
      key: sticker.id,
      art: sticker.art,
      fresh: sticker.createdAt >= openedAt.current,
    });
  }
  for (const item of pending) {
    if (cells.length >= sheet.capacity) break;
    cells.push({ key: item.key, art: item.art, fresh: true });
  }
  while (cells.length < sheet.capacity) cells.push(null);

  return (
    <div
      className="grid gap-2 sm:gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {cells.map((cell, index) =>
        cell ? (
          <div
            key={cell.key}
            data-testid="sticker"
            className={`flex aspect-square items-center justify-center rounded-full text-2xl shadow-sm sm:text-3xl ${
              cell.fresh ? "animate-pop" : ""
            }`}
            style={{ backgroundColor: accent, color: "#fff" }}
          >
            <span className="drop-shadow-sm">{cell.art ?? "⭐"}</span>
          </div>
        ) : (
          <div
            key={`empty-${index}`}
            data-testid="empty-slot"
            className="aspect-square rounded-full border-2 border-dashed border-line/80"
          />
        ),
      )}
    </div>
  );
}
