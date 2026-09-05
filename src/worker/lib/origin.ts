import type { AppContext } from "../types";

/**
 * このアプリが公開されている URL。
 *
 * OAuth のリダイレクト先と、招待リンクの組み立てに使う。
 *
 * 既定ではリクエストの origin をそのまま使う。設定を1つ減らせるうえ、
 * ローカル(:5173)・テスト(:5174/:5175)・本番のどれでも自動的に正しくなる。
 * リバースプロキシの裏など、リクエストから正しい URL が分からない場合だけ
 * APP_ORIGIN で明示的に上書きする。
 */
export function appOrigin(c: AppContext): string {
  const configured = c.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

/**
 * 開発用の入口(PIN もパスワードも無いサインイン)を出してよいか。
 *
 * **明示的に development と言われたときだけ true。**
 * 設定を書き忘れて本番に出たときに、誰でもログインできる状態になるより、
 * 手元で動かないほうがましなので、既定は「本番扱い」にしてある。
 */
export function isDevelopment(c: AppContext): boolean {
  return c.env.ENVIRONMENT === "development";
}
