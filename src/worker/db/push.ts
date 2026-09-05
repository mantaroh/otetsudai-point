import { newId } from "../lib/ids";

/**
 * Web Push の購読と、送信の記録。
 *
 * 購読は endpoint が identity。同じ端末が再登録したときは古い行を無効化して入れ直す。
 * 送信の記録は「同じ日に2回送らない」ための鍵で、状態ではなく通行証として使う。
 */

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SaveSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId: string | null;
  memberId: string | null;
}

export async function saveSubscription(
  db: D1Database,
  familyId: string,
  input: SaveSubscriptionInput,
): Promise<void> {
  const now = Date.now();
  // 同じ endpoint の古い購読を先に無効化する。家庭をまたいで端末が移ることもある。
  await db.batch([
    db
      .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ? AND revoked_at IS NULL")
      .bind(now, input.endpoint),
    db
      .prepare(
        `INSERT INTO push_subscriptions
           (id, family_id, device_id, member_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("psb"),
        familyId,
        input.deviceId,
        input.memberId,
        input.endpoint,
        input.p256dh,
        input.auth,
        now,
      ),
  ]);
}

/** 自分の家庭の購読だけを解除する。無ければ false。 */
export async function removeSubscription(
  db: D1Database,
  familyId: string,
  endpoint: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE push_subscriptions SET revoked_at = ?
        WHERE family_id = ? AND endpoint = ? AND revoked_at IS NULL`,
    )
    .bind(Date.now(), familyId, endpoint)
    .run();
  return result.meta.changes > 0;
}

export async function listSubscriptions(
  db: D1Database,
  familyId: string,
): Promise<StoredSubscription[]> {
  const { results } = await db
    .prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE family_id = ? AND revoked_at IS NULL`,
    )
    .bind(familyId)
    .all<StoredSubscription>();
  return results;
}

export async function markSent(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET last_sent_at = ?, failed_count = 0 WHERE id = ?")
    .bind(at, id)
    .run();
}

/** 5回続けて失敗したら、届かない購読とみなして無効化する */
export async function markFailed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE push_subscriptions
          SET failed_count = failed_count + 1,
              revoked_at = CASE WHEN failed_count + 1 >= 5 THEN ? ELSE revoked_at END
        WHERE id = ?`,
    )
    .bind(Date.now(), id)
    .run();
}

export async function revokeSubscription(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run();
}

/**
 * その日その種類の通知を、この呼び出しが担当してよいかを決める。
 *
 * 先に行を入れてしまい、入れられたほうだけが送る。
 * 「送ったか」をアプリ側で判定すると、即時送信と Cron が同時に走ったときに
 * 両方とも「まだ送っていない」と読んでしまう。
 */
export async function claimSend(
  db: D1Database,
  familyId: string,
  dayKey: string,
  kind: string,
  at: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO push_sends (family_id, day_key, kind, sent_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(familyId, dayKey, kind, at)
    .run();
  return result.meta.changes === 1;
}
