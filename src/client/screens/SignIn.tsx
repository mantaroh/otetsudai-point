import { useState } from "react";
import { api } from "../api";
import { navigate } from "../router";

/**
 * 未認証の画面。
 *
 * ここに来るのは「おうちの人が初めて開いたとき」だけ。
 * 子供の端末は招待リンクで長期 Cookie を持っているので、この画面を見ることはない。
 */
export function SignInScreen() {
  const [busy, setBusy] = useState(false);
  const isDev = import.meta.env.DEV;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <div className="text-center">
        <p className="text-6xl">⭐</p>
        <h1 className="mt-4 text-2xl font-bold">おてつだいポイント</h1>
        <p className="mt-2 text-sm text-ink-soft">
          シール台帳を、スマホ・タブレット・PC で。
        </p>
      </div>

      <a
        href="/auth/google"
        className="mt-10 block rounded-2xl bg-ink py-4 text-center font-bold text-white"
      >
        Google でログイン
      </a>

      <p className="mt-4 text-center text-xs text-ink-soft">
        ログインするのはおうちの人だけです。
        <br />
        お子さんは、あとから発行する招待リンクで使えるようになります。
      </p>

      {isDev && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await api.devSignIn();
            navigate(result.needsSetup ? "/setup" : "/", { replace: true });
            window.location.reload();
          }}
          className="mt-10 rounded-xl border border-dashed border-line py-3 text-sm text-ink-soft"
        >
          開発用サインイン(ローカルのみ)
        </button>
      )}
    </div>
  );
}
