import { buildPushPayload } from "@block65/webcrypto-web-push";
import { getState } from "../db/bonus";
import {
  claimSend,
  listSubscriptions,
  markFailed,
  markSent,
  revokeSubscription,
  type StoredSubscription,
} from "../db/push";
import { localHour } from "./day";
import type { AppEnv } from "../types";

/**
 * おしらせ通知。
 *
 * 呼ばれる経路は2つ。親が「今日を2倍にする」を押した瞬間と、毎時の Cron。
 * どちらも同じ関数を通り、同じ日に二度送らないことは push_sends の主キーで守る。
 *
 * VAPID 鍵が無い環境（ローカル開発・テスト）では、通行証だけ取って送信はしない。
 * 「送る条件が揃ったか」はテストできて、実際の配信だけが落ちる形にしてある。
 *
 * 通行証（claimSend）は送信を試す前に取る。取った後で送信が全滅しても、その日はもう
 * 再送しない。「同じ日に二重に届く」より「その日は届かないことがある」を選んでいる。
 * 子ども向けの毎日の通知では、重複より欠落のほうが実害が小さいという判断。
 */

export const BONUS_KIND = "bonus";

/** 家庭のローカル時刻でこの時に朝の通知を送る */
export const SEND_HOUR = 8;

export interface PushMessage {
  title: string;
  body: string;
  icon: string;
  tag: string;
  url: string;
}

export function bonusMessage(multiplier: number, key: string): PushMessage {
  return {
    title: `きょうは ポイント${multiplier}ばい デー！`,
    body: `おてつだいすると シールが ${multiplier}まい もらえるよ。いっぱい ためよう！`,
    icon: "/icons/icon-192.png",
    tag: `bonus-${key}`,
    url: "/",
  };
}

/** ローカル時刻がちょうど送信時刻になっている家庭を選ぶ */
export function familiesToNotify(
  rows: Array<{ familyId: string; timeZone: string }>,
  at: number,
): string[] {
  return rows
    .filter((row) => localHour(at, row.timeZone) === SEND_HOUR)
    .map((row) => row.familyId);
}

/**
 * 1件だけ送る。
 *
 * ライブラリに依存するのはこの関数だけ。引数の形が変わったらここだけ直す。
 *
 * `PushSubscription` 型は `expirationTime` を必須で持つ（ブラウザの
 * PushSubscription.toJSON() にならった形）。こちらでは追跡していないので null を渡す。
 */
async function sendOne(
  env: AppEnv,
  subscription: StoredSubscription,
  message: PushMessage,
): Promise<number> {
  const payload = await buildPushPayload(
    { data: JSON.stringify(message), options: { ttl: 60 * 60 * 12 } },
    {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    {
      subject: env.VAPID_SUBJECT!,
      publicKey: env.VAPID_PUBLIC_KEY!,
      privateKey: env.VAPID_PRIVATE_KEY!,
    },
  );
  const response = await fetch(subscription.endpoint, payload);
  return response.status;
}

function hasVapidKeys(env: AppEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/** 送信結果をどう扱うか。ステータスの判断だけを切り出して、単体テストで固定する。 */
export type DeliveryOutcome = "sent" | "revoke" | "failed";

export function deliveryOutcome(status: number): DeliveryOutcome {
  if (status === 404 || status === 410) return "revoke"; // 購読が失効している
  if (status >= 200 && status < 300) return "sent";
  // 3xx（リダイレクト）は配達できていないので sent 扱いにしない
  return "failed";
}

/**
 * その家庭に「今日は2倍」を送る。
 * 送る担当になれなかった（既に今日ぶんが送られている）場合は false。
 */
export async function notifyBonus(
  env: AppEnv,
  familyId: string,
  at: number,
): Promise<boolean> {
  const state = await getState(env.DB, familyId, at);
  if (!state.active) return false;

  const claimed = await claimSend(env.DB, familyId, state.dayKey, BONUS_KIND, at);
  if (!claimed) return false;

  if (!hasVapidKeys(env)) {
    console.log("notifyBonus: VAPID 鍵が未設定のため配信を省略", { familyId });
    return true;
  }

  const message = bonusMessage(state.multiplier, state.dayKey);
  const subscriptions = await listSubscriptions(env.DB, familyId);

  for (const subscription of subscriptions) {
    try {
      const status = await sendOne(env, subscription, message);
      switch (deliveryOutcome(status)) {
        case "revoke":
          // 購読が失効している。掃除して次から送らない。
          await revokeSubscription(env.DB, subscription.id);
          break;
        case "failed":
          await markFailed(env.DB, subscription.id);
          break;
        case "sent":
          await markSent(env.DB, subscription.id, at);
          break;
      }
    } catch (error) {
      console.error("push の送信に失敗", { id: subscription.id, error: String(error) });
      await markFailed(env.DB, subscription.id);
    }
  }
  return true;
}

/** 毎時の Cron から呼ぶ。送信対象になった家庭の数を返す。 */
export async function runBonusNotifications(env: AppEnv, at: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT family_id, timezone FROM family_settings",
  ).all<{ family_id: string; timezone: string }>();

  const targets = familiesToNotify(
    results.map((row) => ({ familyId: row.family_id, timeZone: row.timezone })),
    at,
  );

  let sent = 0;
  for (const familyId of targets) {
    // 1家庭の失敗で残り全部の送信が止まらないように、ここで区切って止める
    try {
      if (await notifyBonus(env, familyId, at)) sent += 1;
    } catch (error) {
      console.error("notifyBonus に失敗", { familyId, error: String(error) });
    }
  }
  return sent;
}
