import { useEffect, useState } from "react";
import { useBootstrap } from "../hooks";
import { canUsePush, pushPermission, subscribeToPush } from "../lib/push";
import { track } from "../lib/telemetry";

/**
 * ポイント2倍デーの帯。
 *
 * 気づかせるだけで終わらせず、そのままお手伝いに進めるようにする。
 * 「見えているのに押されていない」が後から分かるよう、表示とタップを記録する。
 */
export function BonusBanner({ onStart }: { onStart?: () => void }) {
  const { data } = useBootstrap();
  const active = data?.bonusToday?.active === true;
  const multiplier = data?.bonusToday?.multiplier ?? 1;

  useEffect(() => {
    if (active) track("view", "bonus-banner");
  }, [active]);

  const [asked, setAsked] = useState(false);
  const showNotifyButton = !asked && canUsePush() && pushPermission() === "default";

  if (!active) return <div data-testid="bonus-banner-slot" />;

  return (
    <div
      data-testid="bonus-banner-slot"
      className="paper-card animate-shimmer border-accent/40 p-4 text-center"
    >
      <p className="text-xl font-bold text-accent">きょうは ポイント2ばい デー！</p>
      <p className="mt-1 text-ink-soft">
        おてつだいすると シールが {multiplier}まい もらえるよ
      </p>
      {onStart && (
        <button
          type="button"
          className="mt-3 w-full rounded-xl bg-accent py-3 font-bold text-white"
          onClick={() => {
            track("action", "bonus-banner:start");
            onStart();
          }}
        >
          いま おてつだいする
        </button>
      )}
      {showNotifyButton && (
        <button
          type="button"
          className="mt-2 w-full rounded-xl border border-line bg-card py-2 text-sm text-ink-soft"
          onClick={async () => {
            track("action", "bonus-banner:notify");
            try {
              await subscribeToPush();
            } catch {
              // subscribeToPush() 自身は失敗を false に丸める作りだが、
              // ここでも受け止めておく。React はボタンの onClick が返す
              // Promise を待たないので、catch が無いと未処理の rejection として漏れる。
            } finally {
              setAsked(true);
            }
          }}
        >
          おしらせを うけとる
        </button>
      )}
    </div>
  );
}
