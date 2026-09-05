import { useEffect } from "react";
import { useBootstrap } from "../hooks";
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
    </div>
  );
}
