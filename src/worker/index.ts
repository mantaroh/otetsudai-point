import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveAuth, requireAuth } from "./auth/middleware";
import { authRoutes } from "./routes/auth";
import { bonusRoutes } from "./routes/bonus";
import { choreRoutes } from "./routes/chores";
import { deviceRoutes } from "./routes/devices";
import { familyRoutes, familySetupRoutes } from "./routes/family";
import { insightsRoutes } from "./routes/insights";
import { ledgerRoutes } from "./routes/ledger";
import { pushRoutes } from "./routes/push";
import { runBonusNotifications } from "./lib/notify";
import type { AppBindings, AppEnv } from "./types";

const app = new Hono<AppBindings>();

/**
 * 署名鍵が無いまま起動すると、Cookie の偽造が可能な状態で動いてしまう。
 * 起動できないほうがまし、として即座に落とす。
 */
app.use("*", async (c, next) => {
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32) {
    return c.json(
      {
        error: "misconfigured",
        message:
          "SESSION_SECRET が設定されていません。ローカルは .dev.vars に、本番は `wrangler secret put SESSION_SECRET` で設定してください。",
      },
      500,
    );
  }
  await next();
});

// API のレスポンスは常に都度取得。CDN にも中間キャッシュにも残さない。
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

app.use("*", resolveAuth);

// 認証の入口(/auth/*, /invite/*, /api/me)
app.route("/", authRoutes);

// まだ家庭に属していない状態でも呼べるもの
app.route("/api", familySetupRoutes);

// ここから先はすべて、家庭スコープの認証が確定していることが前提
const api = new Hono<AppBindings>();
api.use("*", requireAuth);
api.route("/", ledgerRoutes);
api.route("/", choreRoutes);
api.route("/", deviceRoutes);
api.route("/", familyRoutes);
api.route("/", insightsRoutes);
api.route("/", bonusRoutes);
api.route("/", pushRoutes);
app.route("/api", api);

app.notFound((c) =>
  c.json({ error: "not_found", message: "見つかりませんでした" }, 404),
);

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    if (response) return response;
  }
  console.error("unhandled error", error);
  return c.json({ error: "server_error", message: "サーバでエラーが発生しました" }, 500);
});

/**
 * HTTP と Cron の両方を持つ Worker。
 *
 * 定期実行は「朝8時の家庭に2倍デーの通知を送る」だけ。
 * 判定も送信も notify.ts に置いてあるので、ここは呼ぶだけにしておく。
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      runBonusNotifications(env, Date.now()).catch((error) => {
        console.error("朝の通知に失敗", String(error));
      }),
    );
  },
};
