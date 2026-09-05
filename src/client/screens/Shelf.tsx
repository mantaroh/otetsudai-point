import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useBootstrap } from "../hooks";
import { track, useScreen } from "../lib/telemetry";
import { useNavigate } from "../router";

/**
 * 本棚。交換ずみの台帳が「何と交換したか」つきで並ぶ。
 *
 * 紙のときは親が回収してしまって手元に残らなかった部分で、
 * アプリ化のいちばんの付加価値。積み上がった冊数がそのままモチベーションになる。
 */
export function ShelfScreen({ memberId }: { memberId: string }) {
  const { data } = useBootstrap();
  const navigate = useNavigate();

  const sheets = useQuery({
    queryKey: ["shelf", memberId],
    queryFn: () => api.shelf(memberId),
  });
  const redemptions = useQuery({
    queryKey: ["redemptions", memberId],
    queryFn: () => api.redemptions(memberId),
  });
  useScreen("shelf", memberId);

  const member = data?.members.find((m) => m.id === memberId);
  if (!member) return null;

  const accent = member.color ?? "#f2994a";
  const rewardBySheet = new Map(
    (redemptions.data ?? []).map((redemption) => [redemption.sheetId, redemption]),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          aria-label="もどる"
          onClick={() => {
            track("action", "back");
            navigate(`/m/${memberId}`);
          }}
          className="rounded-full bg-paper-deep px-3 py-2 text-sm"
        >
          ←
        </button>
        <h1 className="text-xl font-bold">{member.name}のほんだな</h1>
      </header>

      {sheets.isLoading && <p className="text-center text-ink-soft">よみこみちゅう…</p>}

      {sheets.data?.length === 0 && (
        <div className="paper-card p-8 text-center">
          <p className="text-4xl">📚</p>
          <p className="mt-3 font-bold">まだ1さつもないよ</p>
          <p className="mt-1 text-sm text-ink-soft">
            シールを{data?.settings.capacity ?? 30}まいあつめて、こうかんするとここにならびます
          </p>
        </div>
      )}

      <div className="space-y-4">
        {sheets.data?.map((sheet) => {
          const reward = rewardBySheet.get(sheet.id);
          return (
            <div key={sheet.id} className="paper-card p-5">
              <div className="flex items-baseline justify-between">
                <p className="font-bold">{sheet.seqNo}さつめ</p>
                <p className="text-sm text-ink-soft">
                  {sheet.redeemedAt ? formatDate(sheet.redeemedAt) : ""}
                </p>
              </div>

              <div className="my-3 flex flex-wrap gap-1">
                {sheet.stickers.map((sticker) => (
                  <span
                    key={sticker.id}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-sm"
                    style={{ backgroundColor: accent }}
                  >
                    {sticker.art ?? "⭐"}
                  </span>
                ))}
              </div>

              {reward && (
                <div className="rounded-xl bg-paper-deep px-4 py-3">
                  <p className="text-xs text-ink-soft">こうかんしたもの</p>
                  <p className="font-bold">{reward.rewardText}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
