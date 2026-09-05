import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * 招待リンクを開いたときの確認画面。
 *
 * **開いただけでは何も起こらない。** 登録するのはボタンを押したときだけ。
 * リンクを開くと即座に端末が登録される作りにしていたところ、
 * LINE に送った時点でリンクプレビューの取得に使い切られてしまった。
 * 「開く」は誰が踏むか分からない、という前提で作る。
 */
const KIND_LABELS: Record<string, string> = {
  shared: "みんなで使う端末",
  child: "子ども専用の端末",
  parent: "おうちの人の端末",
};

export function InviteScreen({ token }: { token: string }) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.peekInvite(token),
    retry: false,
    // 確認画面を開いたままでも、勝手に状態が変わらないようにする
    refetchOnWindowFocus: false,
  });

  async function claim() {
    setClaiming(true);
    setError(null);
    try {
      await api.claimInvite(token);
      // 登録できたら、Cookie を持った状態で入り直す
      window.location.href = "/";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "うまくいきませんでした");
      setClaiming(false);
    }
  }

  if (invite.isPending) {
    return (
      <Frame>
        <p className="animate-pulse text-4xl">⭐</p>
      </Frame>
    );
  }

  if (invite.isError || invite.data.status === "unknown") {
    return (
      <Frame>
        <p className="text-5xl">🔎</p>
        <h1 className="mt-4 text-xl font-bold">このリンクは見つかりません</h1>
        <p className="mt-2 text-sm text-ink-soft">
          おうちの人に、もう一度リンクを発行してもらってください。
        </p>
      </Frame>
    );
  }

  if (invite.data.status === "used" || invite.data.status === "expired") {
    return (
      <Frame>
        <p className="text-5xl">⌛</p>
        <h1 className="mt-4 text-xl font-bold">
          {invite.data.status === "used" ? "このリンクは使用ずみです" : "このリンクは期限切れです"}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          おうちの人に、もう一度リンクを発行してもらってください。
          <br />
          リンクは1回だけ使えて、30分で切れます。
        </p>
      </Frame>
    );
  }

  const { familyName, label, kind, memberName } = invite.data;

  return (
    <Frame>
      <p className="text-5xl">📱</p>
      <h1 className="mt-4 text-xl font-bold">この端末を登録しますか?</h1>

      <dl className="mt-6 w-full space-y-2 text-left">
        <Row label="家族">{familyName}</Row>
        <Row label="端末の名前">{label}</Row>
        <Row label="種類">{kind ? (KIND_LABELS[kind] ?? kind) : ""}</Row>
        {memberName && <Row label="使う人">{memberName}</Row>}
      </dl>

      <p className="mt-4 text-sm text-ink-soft">
        登録すると、この端末では次からログインなしで使えるようになります。
      </p>

      {error && (
        <p className="mt-4 w-full rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <button
        type="button"
        onClick={claim}
        disabled={claiming}
        className="mt-6 w-full rounded-2xl bg-accent py-4 text-lg font-bold text-white disabled:opacity-40"
      >
        {claiming ? "登録しています…" : "この端末を登録する"}
      </button>

      <p className="mt-3 text-xs text-ink-soft">
        心当たりがなければ、このまま閉じてください。まだ何も登録されていません。
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 rounded-xl bg-paper-deep px-4 py-2">
      <dt className="shrink-0 text-xs text-ink-soft">{label}</dt>
      <dd className="truncate font-bold">{children}</dd>
    </div>
  );
}
