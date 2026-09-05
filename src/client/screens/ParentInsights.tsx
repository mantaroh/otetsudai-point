import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NamedCount, UiInsights } from "../../shared/types";
import { api } from "../api";
import { useBootstrap, useRefreshBootstrap } from "../hooks";
import { useScreen } from "../lib/telemetry";
import { usePin } from "../pin";

/**
 * つかわれかた。
 *
 * 画面の操作記録を、UI を直すときに使える形まで丸めて出す。
 * 数を眺めるための画面ではないので、「つまずき」には必ず
 * 「だから何を直せばいいか」を添える。それが無い数字は載せない。
 */
export function InsightsTab() {
  const { data } = useBootstrap();
  const [days, setDays] = useState(30);
  useScreen("parent-insights");

  /**
   * せっていと同じ扱いで、開いた瞬間にテンキーを出さない。
   * まず PIN なしで試して、断られたら「見る」ボタンだけを出す。
   */
  const insights = useQuery({
    queryKey: ["insights", days],
    queryFn: () => api.insights(days),
    retry: false,
  });

  if (!data) return null;

  return (
    <div className="space-y-6">
      <nav className="flex gap-1 rounded-xl bg-paper-deep p-1">
        {[7, 30, 90].map((span) => (
          <button
            key={span}
            type="button"
            onClick={() => setDays(span)}
            className={`flex-1 rounded-lg py-2 text-sm font-bold transition ${
              days === span ? "bg-card shadow-sm" : "text-ink-soft"
            }`}
          >
            {span}日
          </button>
        ))}
      </nav>

      {insights.isPending && <p className="py-10 text-center text-ink-soft">よみこみちゅう…</p>}
      {insights.isError && <Locked onUnlocked={() => insights.refetch()} />}
      {insights.data && <Report insights={insights.data} />}

      <RetentionSection />
    </div>
  );
}

function Locked({ onUnlocked }: { onUnlocked: () => void }) {
  const { withPin } = usePin();
  const [error, setError] = useState<string | null>(null);

  return (
    <Section title="つかわれかた" hint="おうちの人の確認が必要です。">
      <button
        type="button"
        onClick={async () => {
          setError(null);
          try {
            await withPin((pin) => api.insights(30, pin));
            onUnlocked();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
          }
        }}
        className="w-full rounded-xl bg-paper-deep py-3 text-sm font-bold"
      >
        見る
      </button>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

function Report({ insights }: { insights: UiInsights }) {
  const { data } = useBootstrap();

  if (insights.events === 0) {
    return (
      <Section title="まだ記録がありません">
        <p className="text-sm text-ink-soft">
          この期間には操作の記録がありません。しばらく使ってから見てください。
        </p>
      </Section>
    );
  }

  const nameOf = (memberId: string) =>
    data?.members.find((member) => member.id === memberId)?.name ?? "(いない人)";

  const { funnel, firstSticker } = insights;

  return (
    <>
      <Section title="ぜんたい">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="ひらいた回数" value={String(insights.sessions)} />
          <Stat label="シールを貼った" value={String(countOf(insights.actions, "stick"))} />
          <Stat label="1枚目まで" value={formatMs(firstSticker.p50Ms)} />
        </div>
      </Section>

      <Section
        title="だいちょうを開いてから貼るまで"
        hint="ここが落ちている所が、いちばん直す価値のある所。"
      >
        <ol className="space-y-2">
          <FunnelStep label="だいちょうを開いた" value={funnel.opened} of={funnel.opened} />
          <FunnelStep label="お手伝いをえらんだ" value={funnel.picked} of={funnel.opened} />
          <FunnelStep label="シールを貼った" value={funnel.stuck} of={funnel.opened} />
        </ol>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <Stat label="1枚目まで(中央)" value={formatMs(firstSticker.p50Ms)} />
          <Stat label="おそいほう(90%)" value={formatMs(firstSticker.p90Ms)} />
          <Stat
            label="1枚目までのタップ"
            value={firstSticker.medianTaps === null ? "—" : `${firstSticker.medianTaps}回`}
          />
        </dl>
        {firstSticker.samples > 0 && (
          <p className="mt-2 text-xs text-ink-soft">{firstSticker.samples}件から</p>
        )}
      </Section>

      <Section title="つまずき" hint="押したのに何も起きなかった、すぐ引き返した、といった動き。">
        {insights.frictions.length === 0 ? (
          <p className="text-sm text-ink-soft">この期間では見つかりませんでした。</p>
        ) : (
          <ul className="space-y-3">
            {insights.frictions.map((item) => (
              <li key={`${item.name}-${item.screen}-${item.detail}`}>
                <div className="flex items-baseline gap-2">
                  <span className="font-bold">{frictionLabel(item)}</span>
                  <span className="ml-auto shrink-0 text-sm text-ink-soft">{item.count}回</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">{FRICTION_HINTS[item.name] ?? ""}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="画面ごと" hint="滞在時間が長い画面は、迷っているか、単に見て楽しんでいるか。">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-soft">
              <th className="pb-1 font-normal">画面</th>
              <th className="pb-1 text-right font-normal">ひらいた</th>
              <th className="pb-1 text-right font-normal">滞在(中央)</th>
            </tr>
          </thead>
          <tbody>
            {insights.screens.map((screen) => (
              <tr key={screen.screen} className="border-t border-line">
                <td className="py-1.5">{SCREEN_LABELS[screen.screen] ?? screen.screen}</td>
                <td className="py-1.5 text-right tabular-nums">{screen.views}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatMs(screen.medianDwellMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="よく押されたもの" hint="使われていない機能は、置き場所が悪いか、要らない。">
        <Ranking items={insights.actions} labels={ACTION_LABELS} />
      </Section>

      {insights.errors.length > 0 && (
        <Section title="うまくいかなかった操作" hint="子どもの前でエラーが出た回数。">
          <ul className="space-y-1 text-sm">
            {insights.errors.map((item) => (
              <li key={`${item.name}-${item.detail}`} className="flex gap-2">
                <span className="flex-1 truncate">{errorLabel(item)}</span>
                <span className="shrink-0 text-ink-soft">{item.count}回</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {insights.members.length > 0 && (
        <Section title="子ごと" hint="同じ画面でも、年齢が違えば詰まる所は違う。">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-soft">
                <th className="pb-1 font-normal">だれ</th>
                <th className="pb-1 text-right font-normal">ひらいた</th>
                <th className="pb-1 text-right font-normal">貼った</th>
                <th className="pb-1 text-right font-normal">もどした</th>
                <th className="pb-1 text-right font-normal">1枚目まで</th>
              </tr>
            </thead>
            <tbody>
              {insights.members.map((member) => (
                <tr key={member.memberId} className="border-t border-line">
                  <td className="py-1.5">{nameOf(member.memberId)}</td>
                  <td className="py-1.5 text-right tabular-nums">{member.sessions}</td>
                  <td className="py-1.5 text-right tabular-nums">{member.sticks}</td>
                  <td className="py-1.5 text-right tabular-nums">{member.undos}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatMs(member.medianFirstStickerMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {insights.daily.length > 0 && <DailySection insights={insights} />}
    </>
  );
}

// ── 部品 ──────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paper-card p-5">
      <h2 className="font-bold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-ink-soft">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-paper-deep px-2 py-3">
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-ink-soft">{label}</p>
    </div>
  );
}

function FunnelStep({ label, value, of }: { label: string; value: number; of: number }) {
  const ratio = of > 0 ? value / of : 0;
  return (
    <li>
      <div className="flex items-baseline gap-2 text-sm">
        <span>{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {value}
          {of > 0 && <span className="ml-1 text-ink-soft">({Math.round(ratio * 100)}%)</span>}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper-deep">
        <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
      </div>
    </li>
  );
}

function Ranking({ items, labels }: { items: NamedCount[]; labels: Record<string, string> }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  if (items.length === 0) return <p className="text-sm text-ink-soft">まだありません。</p>;

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.name}>
          <div className="flex items-baseline gap-2 text-sm">
            <span className="truncate">{labels[item.name] ?? item.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-ink-soft">{item.count}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div
              className="h-full rounded-full bg-accent/70"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DailySection({ insights }: { insights: UiInsights }) {
  const max = Math.max(1, ...insights.daily.map((day) => day.sticks));

  return (
    <Section title="日ごと" hint="棒はその日に貼った枚数。">
      <div className="flex h-24 items-end gap-0.5">
        {insights.daily.map((day) => (
          <div
            key={day.date}
            title={`${day.date}: ${day.sticks}まい / ${day.sessions}回`}
            className="min-w-0 flex-1 rounded-t bg-accent/70"
            style={{ height: `${Math.max(2, (day.sticks / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-soft">
        <span>{insights.daily[0]?.date}</span>
        <span>{insights.daily.at(-1)?.date}</span>
      </div>
    </Section>
  );
}

/**
 * 記録そのものの扱い。
 *
 * 「集めているものを、いつでも止められて、いつでも消せる」を画面から見えるようにする。
 * 子どもの操作記録を持つ以上、ここを設定画面の奥に隠さない。
 */
function RetentionSection() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!data) return null;
  const current = data.settings.uiLogDays;

  async function run(action: (pin?: string) => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await withPin(action);
      await refresh();
      setMessage(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="記録のあつかい"
      hint="操作の記録は、この画面のためだけに使います。家庭の外には出ません。"
    >
      <p className="text-sm">残す期間</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {[0, 30, 90, 180].map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy}
            onClick={() => run((pin) => api.updateSettings({ uiLogDays: option }, pin), "変えました")}
            className={`rounded-full px-4 py-2 text-sm disabled:opacity-40 ${
              current === option ? "bg-accent font-bold text-white" : "bg-paper-deep"
            }`}
          >
            {option === 0 ? "記録しない" : `${option}日`}
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!confirm("これまでの操作記録をすべて消しますか?\n\n台帳やシールの記録は消えません。")) {
            return;
          }
          void run((pin) => api.clearUiEvents(pin), "消しました");
        }}
        className="mt-4 w-full rounded-xl bg-paper-deep py-3 text-sm disabled:opacity-40"
      >
        これまでの記録を消す
      </button>

      {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Section>
  );
}

// ── 表示名 ────────────────────────────────────

function countOf(items: NamedCount[], name: string): number {
  return items.find((item) => item.name === name)?.count ?? 0;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}秒`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}分${Math.round((ms % 60_000) / 1000)}秒`;
}

function frictionLabel(item: NamedCount): string {
  const base = FRICTION_LABELS[item.name] ?? item.name;
  const where = item.screen ? (SCREEN_LABELS[item.screen] ?? item.screen) : null;
  const zone = item.detail ? (ZONE_LABELS[item.detail] ?? item.detail) : null;
  if (where && zone) return `${base}(${where} / ${zone})`;
  if (where) return `${base}(${where})`;
  return base;
}

/** 「何をしようとして、どう失敗したか」の順に読める形にする */
function errorLabel(item: NamedCount): string {
  const what = item.detail ? (OPERATION_LABELS[item.detail] ?? item.detail) : null;
  const how = ERROR_LABELS[item.name] ?? item.name;
  return what ? `${what} ・ ${how}` : how;
}

const SCREEN_LABELS: Record<string, string> = {
  boot: "起動した直後",
  unknown: "わからない画面",
  home: "だれ?",
  ledger: "だいちょう",
  shelf: "ほんだな",
  "parent-sheets": "おうちの人・だいちょう",
  "parent-history": "おうちの人・りれき",
  "parent-insights": "おうちの人・つかわれかた",
  "parent-settings": "おうちの人・せってい",
};

const ZONE_LABELS: Record<string, string> = {
  "sheet-grid": "だいちょうのマス",
  "chore-picker": "お手伝いの一覧",
  "chore-add": "そのほかの入力",
  "stick-pad": "シールを貼るところ",
  "ledger-header": "だいちょうの見出し",
  children: "子のカード",
  none: "そのほかの場所",
};

const ACTION_LABELS: Record<string, string> = {
  "pick-child": "子をえらぶ",
  "open-parent": "おうちの人のがめんへ",
  "open-shelf": "ほんだなを見る",
  back: "もどる",
  "back-gesture": "ブラウザの戻る",
  "chore-pick": "お手伝いをえらぶ",
  "chore-reselect": "えらびなおす",
  "chore-add-open": "そのほかを開く",
  "chore-add-save": "お手伝いを追加する",
  stick: "シールを貼る",
  undo: "1まいもどす",
  "request-redeem": "こうかんしたい",
  "redeem-open": "ハンコの画面を開く",
  "redeem-submit": "ハンコをおす",
  approve: "申請をOKする",
  reject: "申請をことわる",
  revoke: "シールを取り消す",
  "pin-ok": "PIN が通った",
  "parent-tab": "タブを切り替える",
};

/** 失敗したときに何をしようとしていたか。api.ts で付けた操作名に対応する */
const OPERATION_LABELS: Record<string, string> = {
  bootstrap: "だいちょうの読み込み",
  stick: "シールを貼る",
  "grant-revoke": "シールを取り消す",
  "grant-approve": "申請をOKする",
  "chore-add": "お手伝いを追加する",
  "redeem-request": "こうかんしたい",
  redeem: "ハンコをおす",
  shelf: "ほんだなを見る",
  history: "りれきを見る",
  settings: "せっていを読む",
  "settings-update": "せっていを変える",
  insights: "つかわれかたを見る",
};

const ERROR_LABELS: Record<string, string> = {
  network: "つながらなかった",
  // サーバは受け取ったが、形が合わずに入らなかった記録。
  // 出ているなら、記録を送る側とサーバの取り決めがずれている
  dropped: "記録が一部とどかなかった",
  not_found: "見つからなかった",
  forbidden: "権限が足りなかった",
  conflict: "先に別の操作が入っていた",
  too_many_requests: "続けて押しすぎた",
};

const FRICTION_LABELS: Record<string, string> = {
  "dead-tap": "反応しない場所をタップ",
  "rage-tap": "同じ所を連打",
  revisit: "開いてすぐ引き返した",
  "undo-fast": "貼ってすぐ戻した",
  "pin-wrong": "PIN をまちがえた",
  "pin-cancel": "PIN の入力をやめた",
  "chore-add-cancel": "そのほかの入力をやめた",
  "redeem-cancel": "ハンコの画面をやめた",
  "revoke-cancel": "取り消しをやめた",
};

/** 「だから何を直すか」まで書く。数字だけ出しても手が動かない */
const FRICTION_HINTS: Record<string, string> = {
  "dead-tap": "押せると思って押されている。押せるようにするか、押せなさそうな見た目にする。",
  "rage-tap": "押しても何も起きていないか、反応が遅い。押した手ごたえを先に返す。",
  revisit: "目当てのものがそこに無い。前の画面から分かるようにする。",
  "undo-fast": "貼るつもりが無かった。ボタンが近すぎる、または押しやすすぎる。",
  "pin-wrong": "多いなら、桁数を減らすか PIN の要る操作を減らす。",
  "pin-cancel": "PIN を出す場面そのものが多すぎないか見直す。",
  "chore-add-cancel": "メニューに無いものを足そうとして諦めている。よく使うものを最初から載せる。",
  "redeem-cancel": "入力の項目が多い、または何を書けばいいか分からない。",
  "revoke-cancel": "確認の文面が分かりにくいか、押し間違えて開いている。",
};
