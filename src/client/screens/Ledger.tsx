import { useRef, useState } from "react";
import type { Chore } from "../../shared/types";
import { api } from "../api";
import { BonusBanner } from "../components/BonusBanner";
import { Confetti } from "../components/Confetti";
import { SheetGrid, type PendingSticker } from "../components/SheetGrid";
import { useBootstrap, useRefreshBootstrap } from "../hooks";
import { hiddenElapsed, screenTaps, track, useScreen, visibleSince } from "../lib/telemetry";
import { usePin } from "../pin";
import { useNavigate } from "../router";

/**
 * 台帳の画面。このアプリで一番よく開かれる。
 *
 * 設計の意図:
 *   - お手伝いを選んだあとは、大きなシールボタンを「押した回数だけ」貼られる。
 *     まとめて確定するボタンは置かない。紙のシールを1枚ずつ貼る感覚をそのまま残す。
 *   - 通信を待たずに貼られて見える(楽観表示)。子供は待たない。
 *   - 直後の押し間違いは「1まいもどす」でその場で戻せる。
 */
export function LedgerScreen({ memberId }: { memberId: string }) {
  const { data } = useBootstrap();
  const refresh = useRefreshBootstrap();
  const navigate = useNavigate();
  const { withPin } = usePin();

  const [chore, setChore] = useState<Chore | null>(null);
  const [pending, setPending] = useState<PendingSticker[]>([]);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [celebrate, setCelebrate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(0);
  const choresRef = useRef<HTMLDivElement>(null);

  useScreen("ledger", memberId);

  // 「台帳を開いてから1枚目を貼るまで」を測る。
  // この画面でいちばん見たい数字がこれで、長い/タップが多いなら導線が悪い。
  // 数えるのは画面が見えていた時間だけ。開いたまま翌日に貼られると、
  // 背面の時間まで含めて29時間という値が記録されていた
  const openedAt = useRef(Date.now());
  const openedHidden = useRef(hiddenElapsed());
  const firstStickDone = useRef(false);
  const lastStickAt = useRef(0);

  const member = data?.members.find((m) => m.id === memberId);
  const sheet = data?.sheets[memberId];
  if (!data || !member || !sheet) return <Loading />;

  const accent = member.color ?? "#f2994a";
  // 2倍デーの倍率。bonusToday が無い/非アクティブなら1倍として扱う
  const multiplier = data.bonusToday?.active === true ? data.bonusToday.multiplier : 1;
  const remaining = Math.max(0, sheet.capacity - sheet.filled - pending.length);
  const isFull = remaining === 0;
  // 満了して親のハンコを待っている台帳。繰り越しが起きると、いま貼っている台帳とは別に存在する
  const awaiting = data.pendingSheets.filter((item) => item.memberId === memberId);
  // 承認あり運用の家庭でだけ溜まる、承認待ちの申請
  const requests = data.pendingGrants.filter((item) => item.memberId === memberId);
  const needsApproval = data.settings.requireApproval;

  async function stick(selected: Chore, count = 1) {
    setError(null);
    setNotice(null);

    // 承認あり運用では、押しても即シールにはならない。
    // 貼れたように見せてから消えると、いちばん残念な体験になる。
    //
    // 2倍デーはサーバが count × multiplier 枚のシールを発行する。
    // 楽観表示の枚数をそれに合わせておかないと、サーバの返事が届いた瞬間に
    // 「押した数だけ貼られたはずの見た目」から急に枚数が増えて見えてしまう。
    const effectiveCount = count * multiplier;
    const keys: string[] = needsApproval
      ? []
      : Array.from({ length: effectiveCount }, () => crypto.randomUUID());
    if (keys.length > 0) {
      setPending((current) => [...current, ...keys.map((key) => ({ key, art: selected.emoji }))]);
    }

    inFlight.current += 1;
    try {
      const result = await api.grant({
        memberId,
        choreId: selected.id,
        count,
        requestId: crypto.randomUUID(),
      });
      setUndoStack((current) => [...current, result.grant.id]);

      lastStickAt.current = Date.now();
      track("action", "stick", { value: count, detail: count > 1 ? "bulk" : "single" });
      if (!firstStickDone.current) {
        firstStickDone.current = true;
        track("flow", "first-sticker", {
          value: visibleSince(openedAt.current, openedHidden.current),
        });
        track("flow", "first-sticker-taps", { value: screenTaps() });
      }

      if (needsApproval) {
        setNotice(`「${selected.name}」を おうちの人に おねがいしたよ`);
      } else if (result.becameFull) {
        setCelebrate(true);
        // 30枚たまるのがこの台帳のゴール。到達したこと自体と、
        // 1枚目から何日かかったかを残す。紙の台帳では分からなかった数字。
        // 繰り越しが起きると2冊返るので、いま満了したほうを選ぶ
        const filledAt = Math.max(...result.sheets.map((item) => item.filledAt ?? 0));
        const full = result.sheets.find((item) => item.filledAt === filledAt);
        if (full) track("flow", "sheet-full", { value: daysSince(full.startedAt) });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまく貼れませんでした");
      setPending((current) => current.filter((item) => !keys.includes(item.key)));
    } finally {
      inFlight.current -= 1;
      // 連打の途中で再取得すると表示が巻き戻るので、全部returnしてから一度だけ同期する
      if (inFlight.current === 0) {
        await refresh();
        setPending([]);
      }
    }
  }

  async function undo() {
    const grantId = undoStack.at(-1);
    if (!grantId) return;
    setUndoStack((current) => current.slice(0, -1));

    const sinceStick = Date.now() - lastStickAt.current;
    track("action", "undo");
    // 貼った直後に戻している = 押すつもりが無かった。誤タップの目印になる
    if (lastStickAt.current > 0 && sinceStick < 5_000) {
      track("friction", "undo-fast", { value: sinceStick });
    }

    try {
      await withPin((pin) => api.revokeGrant(grantId, undefined, pin));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "もどせませんでした");
    }
  }

  async function askForRedeem(sheetId: string) {
    track("action", "request-redeem");
    try {
      await api.requestRedeem(sheetId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-40 pt-4">
      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}

      <header className="flex items-center gap-3" data-zone="ledger-header">
        <button
          type="button"
          aria-label="もどる"
          onClick={() => {
            track("action", "back");
            navigate("/");
          }}
          className="rounded-full bg-paper-deep px-3 py-2 text-sm"
        >
          ←
        </button>
        <span className="text-3xl">{member.avatar ?? "🙂"}</span>
        <div className="flex-1">
          <h1 className="text-xl font-bold">{member.name}のだいちょう</h1>
          <p className="text-sm text-ink-soft">
            {sheet.seqNo}さつめ ・ {sheet.filled + pending.length} / {sheet.capacity}まい
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            track("action", "open-shelf");
            navigate(`/m/${memberId}/shelf`);
          }}
          className="rounded-full bg-paper-deep px-4 py-2 text-sm"
        >
          ほんだな
        </button>
      </header>

      <div className="mt-4">
        <BonusBanner onStart={() => choresRef.current?.scrollIntoView({ behavior: "smooth" })} />
      </div>

      <p className="mt-4 text-center text-lg font-bold" style={{ color: accent }}>
        {isFull ? "いっぱいになったよ!" : `あと ${remaining} まい`}
      </p>

      {/* 台帳のマスを直接タップしようとするか(空振りタップ)を見るために名前を付ける */}
      <div className="paper-card mt-3 p-4 sm:p-6" data-zone="sheet-grid">
        <SheetGrid sheet={sheet} accent={accent} pending={pending} />
      </div>

      {awaiting.map((item) => (
        <RedeemBanner
          key={item.id}
          seqNo={item.seqNo}
          /** いま貼っている台帳そのものなら、何冊目かはすぐ上に出ているので繰り返さない */
          showSeqNo={item.id !== sheet.id}
          requested={item.redeemRequestedAt !== null}
          accent={accent}
          onRequest={() => askForRedeem(item.id)}
        />
      ))}

      {requests.length > 0 && (
        <section className="paper-card mt-4 p-4">
          <p className="text-sm font-bold">おうちの人まち({requests.length})</p>
          <ul className="mt-2 space-y-1">
            {requests.map((request) => (
              <li key={request.id} className="flex items-center gap-2 text-sm">
                <span className="text-lg">{request.choreEmoji ?? "✨"}</span>
                <span className="flex-1 truncate">{request.choreLabel}</span>
                <span className="text-ink-soft">{request.count}まい</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            おうちの人が OK したら、シールが貼られます
          </p>
        </section>
      )}

      {notice && (
        <p className="mt-4 rounded-xl bg-paper-deep px-4 py-3 text-center text-sm font-bold">
          {notice}
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {error}
        </p>
      )}

      <div
        ref={choresRef}
        className="fixed inset-x-0 bottom-0 border-t border-line bg-card/95 px-4 pb-[env(safe-area-inset-bottom)] pt-3 backdrop-blur"
      >
        <div className="mx-auto max-w-2xl">
          {chore ? (
            <StickPad
              chore={chore}
              accent={accent}
              needsApproval={needsApproval}
              canUndo={undoStack.length > 0}
              onStick={(count) => stick(chore, count)}
              onUndo={undo}
              onBack={() => {
                track("action", "chore-reselect");
                setChore(null);
              }}
            />
          ) : (
            <ChorePicker
              chores={data.chores}
              onPick={(picked) => {
                track("action", "chore-pick");
                setChore(picked);
              }}
              onCreated={async (created) => {
                await refresh();
                setChore(created);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** お手伝いを選んだあとの画面。押すたびに1枚ずつ貼られる。 */
function StickPad({
  chore,
  accent,
  needsApproval,
  canUndo,
  onStick,
  onUndo,
  onBack,
}: {
  chore: Chore;
  accent: string;
  /** 承認あり運用では「貼る」ではなく「おねがいする」になる */
  needsApproval: boolean;
  canUndo: boolean;
  onStick: (count: number) => void;
  onUndo: () => void;
  onBack: () => void;
}) {
  return (
    <div className="pb-3" data-zone="stick-pad">
      <div className="mb-3 flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-full bg-paper-deep px-3 py-1.5 text-sm">
          ← えらびなおす
        </button>
        <span className="truncate text-sm font-bold">
          {chore.emoji ?? "✨"} {chore.name}
        </span>
      </div>

      {/* ここは連打してよい所。押した回数だけ貼るのが仕様なので、
          連打を「つまずき」として数えないよう印を付けておく */}
      <button
        type="button"
        data-rage-ok
        onClick={() => onStick(1)}
        className="w-full rounded-3xl py-7 text-2xl font-bold text-white shadow-lg transition active:scale-[0.97]"
        style={{ backgroundColor: accent }}
      >
        {needsApproval ? "おねがいする" : "シールをはる"}
      </button>

      <div className="mt-2 flex gap-2">
        {chore.defaultCount > 1 && (
          <button
            type="button"
            onClick={() => onStick(chore.defaultCount)}
            className="flex-1 rounded-xl bg-paper-deep py-3 text-sm font-bold"
          >
            まとめて {chore.defaultCount} まい
          </button>
        )}
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="flex-1 rounded-xl bg-paper-deep py-3 text-sm font-bold disabled:opacity-40"
        >
          {needsApproval ? "とりけす" : "1まいもどす"}
        </button>
      </div>
    </div>
  );
}

const NEW_CHORE_EMOJI = ["✨", "🧹", "🍽️", "🧺", "🛁", "🗑️", "👟", "🍚", "🧸", "🐕", "📚", "🚗"];

/**
 * お手伝いの選択。
 * 一覧に無ければ「そのほか」から入力でき、入力されたものはその場でメニューに載る。
 * 以後は兄弟どちらの選択肢にも出てくる(家族共通のマスター)。
 */
function ChorePicker({
  chores,
  onPick,
  onCreated,
}: {
  chores: Chore[];
  onPick: (chore: Chore) => void;
  onCreated: (chore: Chore) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(NEW_CHORE_EMOJI[0]!);
  const [saving, setSaving] = useState(false);

  if (adding) {
    return (
      <form
        className="pb-4"
        data-zone="chore-add"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || saving) return;
          setSaving(true);
          try {
            const created = await api.addChore(name.trim(), emoji);
            // 入力した文字そのものは記録しない。長さも取らない。
            // 「そのほかがどれだけ使われたか」が分かれば、メニューの過不足は判断できる
            track("action", "chore-add-save");
            onCreated(created);
            setAdding(false);
            setName("");
          } catch {
            // 失敗そのものは api.ts が記録する。ここは入力を残して、もう一度押せるようにするだけ
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="mb-2 flex flex-wrap gap-1">
          {NEW_CHORE_EMOJI.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setEmoji(candidate)}
              className={`h-9 w-9 rounded-lg text-lg ${
                emoji === candidate ? "bg-accent/20 ring-2 ring-accent" : "bg-paper-deep"
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="なにをした?"
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl border border-line bg-white px-4 py-3 text-base"
          />
          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="rounded-xl bg-accent px-5 py-3 font-bold text-white disabled:opacity-40"
          >
            OK
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            // 入力を始めて途中でやめた = メニューに無いものを探しにきたのに諦めた
            track("friction", "chore-add-cancel");
            setAdding(false);
          }}
          className="mt-2 w-full py-2 text-sm text-ink-soft underline"
        >
          やめる
        </button>
      </form>
    );
  }

  return (
    <div className="pb-3" data-zone="chore-picker">
      <p className="mb-2 text-center text-sm font-bold text-ink-soft">なにをした?</p>
      <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto pb-1 sm:grid-cols-4">
        {chores.map((chore) => (
          <button
            key={chore.id}
            type="button"
            onClick={() => onPick(chore)}
            className="flex flex-col items-center gap-1 rounded-2xl bg-paper-deep px-2 py-3 transition active:scale-95"
          >
            <span className="text-2xl">{chore.emoji ?? "✨"}</span>
            <span className="line-clamp-2 text-center text-xs leading-tight">{chore.name}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            track("action", "chore-add-open");
            setAdding(true);
          }}
          className="flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed border-line px-2 py-3"
        >
          <span className="text-2xl">➕</span>
          <span className="text-xs">そのほか</span>
        </button>
      </div>
    </div>
  );
}

function RedeemBanner({
  seqNo,
  showSeqNo,
  requested,
  accent,
  onRequest,
}: {
  seqNo: number;
  showSeqNo: boolean;
  requested: boolean;
  accent: string;
  onRequest: () => void;
}) {
  const label = showSeqNo ? `${seqNo}さつめ` : "";

  if (requested) {
    return (
      <div className="paper-card mt-4 p-5 text-center">
        <p className="text-lg font-bold">{label}おうちの人にわたしたよ 🖐️</p>
        <p className="mt-1 text-sm text-ink-soft">
          ハンコをおしてもらったら、ほんだなにならびます
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onRequest}
      className="mt-4 animate-shimmer rounded-2xl py-5 text-xl font-bold text-white"
      style={{ backgroundColor: accent }}
    >
      {label}こうかんしたい!
    </button>
  );
}

/** 台帳の1枚目からの日数。時間ではなく日で見る指標なので、ここで丸める */
function daysSince(at: number): number {
  return Math.max(0, Math.round((Date.now() - at) / 86_400_000));
}

function Loading() {
  return <div className="p-10 text-center text-ink-soft">よみこみちゅう…</div>;
}
