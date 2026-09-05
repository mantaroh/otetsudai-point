import { Hono } from "hono";
import { badRequest, notFound, serverError, unauthorized } from "../lib/errors";
import { randomToken } from "../lib/crypto";
import { appOrigin, isDevelopment } from "../lib/origin";
import { findOrCreateUser, listFamiliesForUser } from "../db/family";
import { claimInvite, peekInvite } from "../db/devices";
import { buildAuthorizeUrl, exchangeCode, pkcePair } from "../auth/google";
import {
  clearAuthCookies,
  readOAuthCookie,
  readSessionCookie,
  setDeviceCookie,
  setFamilyCookie,
  setOAuthCookie,
  setSessionCookie,
} from "../auth/cookies";
import type { AppBindings } from "../types";

/**
 * 認証の入口。
 *   /auth/google     … 親の OAuth
 *   /auth/dev        … ローカル開発用。Google の設定なしで動かすため
 *   /invite/:token   … 招待リンクを開いた端末に、長期 Cookie を配る
 */
export const authRoutes = new Hono<AppBindings>();

authRoutes.get("/auth/google", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw serverError("Google ログインが設定されていません");

  const state = randomToken(16);
  const { verifier, challenge } = await pkcePair();
  await setOAuthCookie(c, state, verifier);

  return c.redirect(
    buildAuthorizeUrl({ clientId, appOrigin: appOrigin(c), state, challenge }),
  );
});

authRoutes.get("/auth/google/callback", async (c) => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = c.env;
  if (!clientId || !clientSecret) throw serverError("Google ログインが設定されていません");

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) throw badRequest("認証のパラメータが足りません");

  const stored = await readOAuthCookie(c);
  // state が一致しない = 別のセッションから始まった認証。CSRF を弾く。
  if (!stored || stored.state !== state) throw badRequest("認証の状態が確認できませんでした");

  const identity = await exchangeCode({
    clientId,
    clientSecret,
    appOrigin: appOrigin(c),
    code,
    verifier: stored.verifier,
  });

  const userId = await findOrCreateUser(c.env.DB, identity);
  await setSessionCookie(c, userId);

  const families = await listFamiliesForUser(c.env.DB, userId);
  const first = families[0];
  if (first) await setFamilyCookie(c, first.id);

  // 家庭がまだ無ければ、そのままオンボーディングへ
  return c.redirect(first ? "/" : "/setup");
});

/**
 * ローカル開発用のサインイン。
 * Google のクライアントIDを用意しなくても手元で一通り動かせるようにするためだけのもので、
 * ENVIRONMENT が development のときしか存在しない。
 */
authRoutes.post("/auth/dev", async (c) => {
  if (!isDevelopment(c)) throw notFound();

  // テストは実行ごとに別の subject を渡して、まっさらな「家庭がまだ無いユーザー」から始める
  const body = await c.req.json<{ subject?: unknown }>().catch(() => ({ subject: undefined }));
  const subject =
    typeof body.subject === "string" && /^[\w-]{1,64}$/.test(body.subject) ? body.subject : "local";

  const userId = await findOrCreateUser(c.env.DB, {
    provider: "dev",
    subject,
    email: `${subject}@localhost`,
    displayName: "ローカル開発ユーザー",
  });
  await setSessionCookie(c, userId);

  const families = await listFamiliesForUser(c.env.DB, userId);
  const first = families[0];
  if (first) await setFamilyCookie(c, first.id);

  return c.json({ ok: true, needsSetup: !first });
});

authRoutes.post("/auth/logout", (c) => {
  clearAuthCookies(c);
  return c.json({ ok: true });
});

/**
 * 招待リンクの中身を見る。**消費しない。**
 *
 * /invite/:token を開くと、この情報をもとに確認画面が出る。
 * 「開いた」だけでは何も起こらないので、LINE などのリンクプレビューや
 * メールのセキュリティスキャナがリンクを踏んでも、招待は生きたまま残る。
 */
authRoutes.get("/api/invites/:token", async (c) => {
  return c.json(await peekInvite(c.env.DB, c.req.param("token")));
});

/**
 * 招待リンクの引き換え。使い捨て・短命のトークンを、その端末の長期 Cookie と交換する。
 *
 * **POST でしか通らないこと自体が仕様。**
 * GET で引き換えられるようにすると、リンクを開いた何か(プレビュー取得、先読み、
 * ウイルス対策のスキャン)が勝手に使い切ってしまう。実際に LINE で送って踏んだ。
 */
authRoutes.post("/api/invites/:token/claim", async (c) => {
  const { familyId, deviceToken } = await claimInvite(c.env.DB, c.req.param("token"));

  setDeviceCookie(c, deviceToken);
  await setFamilyCookie(c, familyId);

  return c.json({ ok: true });
});

/** ログイン状態の確認。UI はこれを見て「未ログイン / 家庭未作成 / 通常」を出し分ける。 */
authRoutes.get("/api/me", async (c) => {
  const session = await readSessionCookie(c);
  const auth = c.get("auth");

  if (!session) {
    // 端末トークンだけで来ている(共有タブレット・子端末)
    if (!auth) throw unauthorized();
    return c.json({ user: null, families: [], currentFamilyId: auth.familyId });
  }

  const [user, families] = await Promise.all([
    c.env.DB.prepare("SELECT id, display_name, email FROM users WHERE id = ?")
      .bind(session.uid)
      .first<{ id: string; display_name: string | null; email: string | null }>(),
    listFamiliesForUser(c.env.DB, session.uid),
  ]);

  return c.json({
    user: user
      ? { id: user.id, displayName: user.display_name, email: user.email }
      : null,
    families,
    currentFamilyId: auth?.familyId ?? null,
  });
});
