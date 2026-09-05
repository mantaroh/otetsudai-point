import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Grant, Member, Sheet } from "../../shared/types";
import { api } from "../api";
import { useBootstrap, useRefreshBootstrap } from "../hooks";
import { track, useScreen } from "../lib/telemetry";
import { usePin } from "../pin";
import { useNavigate } from "../router";
import { InsightsTab } from "./ParentInsights";
import { SettingsTab } from "./ParentSettings";

/**
 * おうちの人の画面。
 *   だいちょう   … 2人の進み具合と、交換のハンコ
 *   りれき       … 誰がいつ何を何枚貼ったか。ここから取り消す
 *   つかわれかた … 画面の操作記録の集計。UI を直すときの手がかり
 *   せってい     … メニュー編集、マス数、端末の招待
 */
type Tab = "sheets" | "history" | "insights" | "settings";

export function ParentScreen() {
  const { data } = useBootstrap();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("sheets");

  if (!data) return null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <header className="mb-4 flex items-center gap-3">
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
        <h1 className="text-xl font-bold">おうちの人のがめん</h1>
      </header>

      <nav className="mb-5 flex gap-1 rounded-xl bg-paper-deep p-1">
        {(
          [
            ["sheets", "だいちょう"],
            ["history", "りれき"],
            ["insights", "つかわれかた"],
            ["settings", "せってい"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              track("action", "parent-tab", { detail: key });
              setTab(key);
            }}
            className={`flex-1 rounded-lg px-1 py-2 text-xs font-bold transition sm:text-sm ${
              tab === key ? "bg-card shadow-sm" : "text-ink-soft"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "sheets" && <SheetsTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "insights" && <InsightsTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}

// ── だいちょう ────────────────────────────────

function SheetsTab() {
  const { data } = useBootstrap();
  const [redeeming, setRedeeming] = useState<{ sheet: Sheet; member: Member } | null>(null);
  useScreen("parent-sheets");
  if (!data) return null;

  const children = data.members.filter((member) => member.role === "child");

  return (
    <div className="space-y-4">
      {/* 承認あり運用の家庭でだけ出る。ここが無いと、子の申請が溜まる一方になる */}
      {data.pendingGrants.length > 0 && <ApprovalQueue />}

      {children.map((child) => {
        const sheet = data.sheets[child.id];
        if (!sheet) return null;
        const accent = child.color ?? "#f2994a";

        return (
          <div key={child.id} className="paper-card p-5">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{child.avatar ?? "🙂"}</span>
              <div className="flex-1">
                <p className="font-bold">{child.name}</p>
                <p className="text-sm text-ink-soft">
                  {sheet.seqNo}さつめ ・ {sheet.filled} / {sheet.capacity} まい
                </p>
              </div>
            </div>

            <div className="mt-3 h-3 overflow-hidden rounded-full bg-paper-deep">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${(sheet.filled / sheet.capacity) * 100}%`,
                  backgroundColor: accent,
                }}
              />
            </div>

            {/* 満了して待っている台帳。繰り越しが起きると、上の進み具合とは別の冊になる */}
            {data.pendingSheets
              .filter((pending) => pending.memberId === child.id)
              .map((pending) => (
                <button
                  key={pending.id}
                  type="button"
                  onClick={() => {
                    track("action", "redeem-open", { memberId: child.id });
                    setRedeeming({ sheet: pending, member: child });
                  }}
                  className="mt-4 w-full rounded-xl bg-accent py-3 font-bold text-white"
                >
                  {pending.seqNo}さつめにハンコをおして交換する
                  {pending.redeemRequestedAt && " (リクエストあり)"}
                </button>
              ))}
          </div>
        );
      })}

      {redeeming && (
        <RedeemDialog
          sheet={redeeming.sheet}
          member={redeeming.member}
          onClose={() => setRedeeming(null)}
        />
      )}
    </div>
  );
}

/**
 * 承認待ちの申請。
 *
 * 「シールに親の承認をもとめる」を有効にした家庭では、子が押した申請がここに並ぶ。
 * 承認して初めてシールが発行される。
 */
function ApprovalQueue() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;

  const nameOf = (memberId: string) =>
    data.members.find((member) => member.id === memberId)?.name ?? "";

  async function act(grantId: string, action: "approve" | "reject") {
    setBusyId(grantId);
    setError(null);
    track("action", action);
    try {
      await withPin((pin) =>
        action === "approve" ? api.approveGrant(grantId, pin) : api.revokeGrant(grantId, undefined, pin),
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="paper-card border-accent/40 p-5">
      <h2 className="font-bold">
        しんせいちゅう
        <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-sm text-white">
          {data.pendingGrants.length}
        </span>
      </h2>
      <p className="mt-1 text-sm text-ink-soft">OK すると、シールが台帳に貼られます。</p>

      <ul className="mt-3 space-y-2">
        {data.pendingGrants.map((grant) => (
          <li key={grant.id} className="flex items-center gap-3 rounded-xl bg-paper-deep p-3">
            <span className="text-2xl">{grant.choreEmoji ?? "✨"}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">
                {nameOf(grant.memberId)} ・ {grant.choreLabel}
              </p>
              <p className="text-xs text-ink-soft">
                {formatDateTime(grant.createdAt)} ・ {grant.count}まい
              </p>
            </div>
            <button
              type="button"
              onClick={() => act(grant.id, "reject")}
              disabled={busyId === grant.id}
              className="rounded-lg bg-card px-3 py-2 text-xs disabled:opacity-40"
            >
              ことわる
            </button>
            <button
              type="button"
              onClick={() => act(grant.id, "approve")}
              disabled={busyId === grant.id}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              OK
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}

const CATEGORIES = [
  { key: "roblox", label: "Roblox" },
  { key: "minecraft", label: "マイクラ" },
  { key: "book", label: "まんが・本" },
  { key: "game", label: "ゲーム" },
  { key: "other", label: "そのほか" },
];

/**
 * 交換のハンコ。
 * 用途を縛らないのが現行の運用なので、カテゴリも金額も必須にしない。
 */
function RedeemDialog({
  sheet,
  member,
  onClose,
}: {
  sheet: Sheet;
  member: Member;
  onClose: () => void;
}) {
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const [rewardText, setRewardText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!rewardText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await withPin((pin) =>
        api.redeem(
          sheet.id,
          {
            rewardText: rewardText.trim(),
            category: category ?? undefined,
            amountYen: amount ? Number(amount) : undefined,
          },
          pin,
        ),
      );
      track("action", "redeem-submit", {
        memberId: member.id,
        detail: category ?? "none",
      });
      await refresh();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
      <div className="paper-card w-full max-w-md animate-rise p-6">
        <h2 className="text-lg font-bold">
          {member.name}の{sheet.seqNo}さつめを交換
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          交換したものを記録すると、本棚に残ります。
        </p>

        <input
          autoFocus
          value={rewardText}
          onChange={(event) => setRewardText(event.target.value)}
          placeholder="Robux 1200 / 鬼滅の刃 20巻 …"
          maxLength={100}
          className="input mt-4"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {CATEGORIES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setCategory(category === item.key ? null : item.key)}
              className={`rounded-full px-3 py-1.5 text-sm ${
                category === item.key ? "bg-accent text-white" : "bg-paper-deep"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/\D/g, "").slice(0, 7))}
          inputMode="numeric"
          placeholder="金額(任意)"
          className="input mt-3"
        />

        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={() => {
              track("friction", "redeem-cancel");
              onClose();
            }}
            className="flex-1 rounded-xl bg-paper-deep py-3"
          >
            やめる
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!rewardText.trim() || busy}
            className="flex-1 rounded-xl bg-accent py-3 font-bold text-white disabled:opacity-40"
          >
            ハンコをおす
          </button>
        </div>
      </div>
    </div>
  );
}

// ── りれき ────────────────────────────────────

function HistoryTab() {
  const { data } = useBootstrap();
  const { withPin } = usePin();
  const refresh = useRefreshBootstrap();
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.history() });
  const [busyId, setBusyId] = useState<string | null>(null);
  useScreen("parent-history");

  const nameOf = (memberId: string) =>
    data?.members.find((member) => member.id === memberId)?.name ?? "";

  async function revoke(grant: Grant) {
    if (!confirm(`「${grant.choreLabel}」の ${grant.count}まい を取り消しますか?`)) {
      track("friction", "revoke-cancel");
      return;
    }
    setBusyId(grant.id);
    track("action", "revoke", { memberId: grant.memberId });
    try {
      await withPin((pin) => api.revokeGrant(grant.id, undefined, pin));
      await Promise.all([refresh(), history.refetch()]);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      {history.data?.map((grant) => (
        <div
          key={grant.id}
          className={`paper-card flex items-center gap-3 p-4 ${grant.revokedAt ? "opacity-50" : ""}`}
        >
          <span className="text-2xl">{grant.choreEmoji ?? "✨"}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">
              {nameOf(grant.memberId)} ・ {grant.choreLabel}
              {grant.revokedAt && <span className="ml-2 text-xs text-red-600">取り消し</span>}
            </p>
            <p className="text-xs text-ink-soft">
              {formatDateTime(grant.createdAt)} ・ {grant.count}まい ・{" "}
              {grant.createdVia === "self" ? "じぶんで" : `${grant.createdByName}がつけた`}
            </p>
          </div>
          {!grant.revokedAt && (
            <button
              type="button"
              onClick={() => revoke(grant)}
              disabled={busyId === grant.id}
              className="rounded-lg bg-paper-deep px-3 py-2 text-xs disabled:opacity-40"
            >
              取り消す
            </button>
          )}
        </div>
      ))}

      {history.data?.length === 0 && (
        <p className="py-10 text-center text-ink-soft">まだ記録がありません</p>
      )}
    </div>
  );
}

function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
