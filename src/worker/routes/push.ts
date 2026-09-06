import { Hono } from "hono";
import { badRequest, notFound } from "../lib/errors";
import { asString, readJson } from "../lib/validate";
import { removeSubscription, saveSubscription } from "../db/push";
import { getAuth } from "../auth/middleware";
import type { AppBindings } from "../types";

/**
 * 通知の購読。
 *
 * 登録するのは主に子の端末なので、親限定にはしない。
 * ただし family_id と device_id はセッションから決める。クライアントの申告は使わない。
 */
export const pushRoutes = new Hono<AppBindings>();

pushRoutes.get("/push/config", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));

pushRoutes.post("/push/subscribe", async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>(
    c.req.raw,
  );

  const endpoint = asString(body.endpoint, "endpoint", { max: 800 });
  if (!/^https:\/\//.test(endpoint)) throw badRequest("endpoint が不正です");

  const keys = body.keys;
  if (!keys) throw badRequest("鍵が足りません");

  await saveSubscription(c.env.DB, auth.familyId, {
    endpoint,
    p256dh: asString(keys.p256dh, "p256dh", { max: 200 }),
    auth: asString(keys.auth, "auth", { max: 200 }),
    deviceId: auth.device?.id ?? null,
    memberId: auth.lockedMemberId ?? auth.device?.memberId ?? null,
  });

  return c.json({ ok: true }, 201);
});

pushRoutes.delete("/push/subscribe", async (c) => {
  const auth = getAuth(c);
  const endpoint = asString(c.req.query("endpoint"), "endpoint", { max: 800 });
  const removed = await removeSubscription(c.env.DB, auth.familyId, endpoint);
  if (!removed) throw notFound("その購読は見つかりませんでした");
  // 無効化した件数を返す。常に1のはずで、テストから「有効な購読は1つだけ」を
  // 外部から確認する手段になる(件数を返さないと2件残っていても見分けがつかない)。
  return c.json({ ok: true, removed });
});
