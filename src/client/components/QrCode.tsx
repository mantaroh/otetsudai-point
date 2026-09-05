import { useEffect, useState } from "react";

/**
 * 招待リンクの QR コード。
 *
 * いちばん手間が少ないのは、渡したい端末のカメラで読んでもらうこと。
 * コピーも貼り付けも要らず、メッセージアプリを経由しないので
 * リンクが他所に流れる心配もない。
 *
 * QR の生成ライブラリは、この画面を開いたときにだけ読み込む(動的 import)。
 * 台帳を開くだけの子どもの端末に、使わないコードを配りたくない。
 */
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const [path, setPath] = useState<{ d: string; cells: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);

    import("uqr")
      .then(({ encode }) => {
        if (!alive) return;
        const { size: cells, data } = encode(value, { border: 2 });

        // マス目を1本のパスにまとめる。rect を千個並べるより軽い
        let d = "";
        for (let y = 0; y < cells; y++) {
          for (let x = 0; x < cells; x++) {
            if (data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
          }
        }
        setPath({ d, cells });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="text-sm text-ink-soft">
        QR コードを作れませんでした。下の URL をお使いください。
      </p>
    );
  }

  if (!path) {
    return (
      <div
        className="animate-pulse rounded-xl bg-paper-deep"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <svg
      role="img"
      aria-label="招待リンクの QR コード"
      width={size}
      height={size}
      viewBox={`0 0 ${path.cells} ${path.cells}`}
      className="rounded-xl bg-white p-1 shadow-sm"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#3d3428" />
    </svg>
  );
}
