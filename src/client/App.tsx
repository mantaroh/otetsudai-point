import { useEffect, useRef } from "react";
import type { BootstrapResponse } from "../shared/types";
import { ApiError } from "./api";
import { useBootstrap, useMe } from "./hooks";
import { setTelemetryEnabled } from "./lib/telemetry";
import { matchPath, navigate, usePath } from "./router";
import { HomeScreen } from "./screens/Home";
import { InviteScreen } from "./screens/Invite";
import { LedgerScreen } from "./screens/Ledger";
import { ParentScreen } from "./screens/Parent";
import { SetupScreen } from "./screens/Setup";
import { ShelfScreen } from "./screens/Shelf";
import { SignInScreen } from "./screens/SignIn";

type Settled =
  | { kind: "ready"; data: BootstrapResponse }
  | { kind: "failed"; error: Error };

/**
 * 最後に「確定した」状態を覚えておく。
 *
 * 裏で再取得している最中は、一瞬どちらでもない状態になる。
 * そこで読み込み中の画面に切り替えてしまうと、React が画面を作り直し、
 * 入力途中のフォームが消える(はじめの設定で実際に起きた)。
 * 確定した状態を持ち続けることで、再取得は画面をちらつかせずに終わる。
 */
function useSettledBootstrap(): Settled | null {
  const query = useBootstrap();
  const settled = useRef<Settled | null>(null);

  // ログアウトなどで取れなくなった場合に古い画面を出し続けないよう、失敗を優先する
  if (query.isError) settled.current = { kind: "failed", error: query.error };
  else if (query.data) settled.current = { kind: "ready", data: query.data };

  return settled.current;
}

export function App() {
  const path = usePath();
  const settled = useSettledBootstrap();

  // 操作記録を残さない設定の家庭では、送信そのものをやめる。
  // 早期 return より前に置く必要があるので、画面の分岐の前でまとめて扱う
  const uiLogDays = settled?.kind === "ready" ? settled.data.settings.uiLogDays : null;
  useEffect(() => {
    if (uiLogDays !== null) setTelemetryEnabled(uiLogDays > 0);
  }, [uiLogDays]);

  // 招待リンクは、まだ何の資格も持っていない端末が開く。
  // 認証の判定より先に扱う(bootstrap は当然 401 になる)。
  const invite = matchPath("/invite/:token", path);
  if (invite?.token) return <InviteScreen token={invite.token} />;

  // まだ一度も確定していないときだけ、読み込み中を出す
  if (!settled) return <Splash />;

  // 家庭スコープの認証が取れない = 未ログイン、または家庭がまだ無い
  if (settled.kind === "failed") {
    const status = settled.error instanceof ApiError ? settled.error.status : 0;
    if (status === 401 || status === 404) return <Unauthenticated path={path} />;
    return <Failure message={settled.error.message} />;
  }

  const data = settled.data;

  // 子ども専用端末は、自分の台帳と本棚しか開かない。
  // きょうだいの URL を直接叩かれても、黙って自分の台帳に戻す。
  const locked = data.auth.lockedMemberId;
  if (locked && path !== `/m/${locked}` && path !== `/m/${locked}/shelf`) {
    return <Redirect to={`/m/${locked}`} />;
  }

  const shelf = matchPath("/m/:memberId/shelf", path);
  if (shelf?.memberId) return <ShelfScreen memberId={shelf.memberId} />;

  const ledger = matchPath("/m/:memberId", path);
  if (ledger?.memberId) return <LedgerScreen memberId={ledger.memberId} />;

  if (path === "/parent") return <ParentScreen />;

  if (path !== "/") return <Redirect to="/" />;
  return <HomeScreen />;
}

/** ログインしているが家庭がまだ無い場合はオンボーディングへ、そうでなければサインインへ。 */
function Unauthenticated({ path }: { path: string }) {
  const me = useMe();

  if (me.isPending) return <Splash />;
  if (me.isError || !me.data?.user) return <SignInScreen />;
  if (me.data.families.length === 0 || path === "/setup") return <SetupScreen />;

  // 家庭はあるのに bootstrap が通らない。Cookie の不整合なので選び直させる。
  return <Failure message="家庭の情報を読み込めませんでした。ログインし直してください。" />;
}

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <Splash />;
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="animate-pulse text-4xl">⭐</p>
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <p className="text-4xl">😵</p>
      <p className="mt-4 font-bold">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 rounded-xl bg-paper-deep px-6 py-3 text-sm"
      >
        もういちど
      </button>
    </div>
  );
}
