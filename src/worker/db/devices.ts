import type { DeviceKind } from "../../shared/types";
import { hashToken, randomToken } from "../lib/crypto";
import { badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";

/**
 * 端末登録。子供にアカウントを持たせないための仕組み。
 *
 * 親が招待リンクを発行 → その端末で開く → 端末に長期 Cookie が入る → 以後ログイン不要。
 * トークンは平文を DB に置かず、ハッシュだけを保存する。
 */

export interface DeviceRecord {
  id: string;
  familyId: string;
  label: string;
  kind: DeviceKind;
  memberId: string | null;
  skipPin: boolean;
}

const INVITE_TTL_MS = 30 * 60 * 1000;

export async function createInvite(
  db: D1Database,
  familyId: string,
  input: { kind: DeviceKind; memberId: string | null; label: string; createdBy: string },
): Promise<{ token: string; expiresAt: number }> {
  if (input.kind === "child" && !input.memberId) {
    throw badRequest("子ども専用の端末には、対象の子を指定してください");
  }

  const token = randomToken();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO device_invites (id, family_id, token_hash, kind, member_id, label,
                                   created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("inv"),
      familyId,
      await hashToken(token),
      input.kind,
      input.memberId,
      input.label,
      input.createdBy,
      Date.now(),
      expiresAt,
    )
    .run();

  return { token, expiresAt };
}

interface InviteRow {
  id: string;
  family_id: string;
  kind: DeviceKind;
  member_id: string | null;
  label: string;
  expires_at: number;
  used_at: number | null;
}

function findInvite(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT id, family_id, kind, member_id, label, expires_at, used_at
         FROM device_invites WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<InviteRow>();
}

export type InviteStatus = "ok" | "used" | "expired" | "unknown";

export interface InvitePreview {
  status: InviteStatus;
  familyName: string | null;
  label: string | null;
  kind: DeviceKind | null;
  memberName: string | null;
}

/**
 * 招待リンクの中身を、**消費せずに**見るだけ。
 *
 * リンクを開いただけで端末が登録されると、LINE などのリンクプレビューや
 * メールのセキュリティスキャナがリンクを踏んだ時点で使用ずみになってしまう。
 * 開く(GET)は何も起こさず、登録は明示的な操作(POST)でだけ行う。
 */
export async function peekInvite(db: D1Database, token: string): Promise<InvitePreview> {
  const invite = await findInvite(db, await hashToken(token));
  if (!invite) {
    return { status: "unknown", familyName: null, label: null, kind: null, memberName: null };
  }

  const family = await db
    .prepare("SELECT name FROM families WHERE id = ? AND deleted_at IS NULL")
    .bind(invite.family_id)
    .first<{ name: string }>();

  const member = invite.member_id
    ? await db
        .prepare("SELECT name FROM members WHERE family_id = ? AND id = ?")
        .bind(invite.family_id, invite.member_id)
        .first<{ name: string }>()
    : null;

  const status: InviteStatus = !family
    ? "unknown"
    : invite.used_at
      ? "used"
      : invite.expires_at < Date.now()
        ? "expired"
        : "ok";

  return {
    status,
    familyName: family?.name ?? null,
    label: invite.label,
    kind: invite.kind,
    memberName: member?.name ?? null,
  };
}

/**
 * 招待リンクを引き換えて端末を登録する。
 *
 * ここは未認証の相手からの呼び出しなので、familyId によるスコープが効かない
 * (トークンそのものが唯一の資格情報)。使い捨て・短命であることが前提。
 *
 * **必ず POST から呼ぶこと。** GET で消費すると、リンクプレビューに潰される。
 */
export async function claimInvite(
  db: D1Database,
  token: string,
): Promise<{ familyId: string; deviceToken: string }> {
  const invite = await findInvite(db, await hashToken(token));

  if (!invite) throw notFound("この招待リンクは無効です");
  if (invite.used_at) throw badRequest("この招待リンクは使用ずみです");
  if (invite.expires_at < Date.now()) throw badRequest("この招待リンクは期限切れです");

  const deviceToken = randomToken();
  const deviceId = newId("dev");
  const now = Date.now();

  await db.batch([
    db
      .prepare(
        `INSERT INTO devices (id, family_id, label, kind, member_id, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deviceId,
        invite.family_id,
        invite.label,
        invite.kind,
        invite.member_id,
        await hashToken(deviceToken),
        now,
        now,
      ),
    db
      .prepare("UPDATE device_invites SET used_at = ?, device_id = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, deviceId, invite.id),
  ]);

  return { familyId: invite.family_id, deviceToken };
}

export async function findDeviceByToken(
  db: D1Database,
  token: string,
): Promise<DeviceRecord | null> {
  const row = await db
    .prepare(
      `SELECT d.id, d.family_id, d.label, d.kind, d.member_id, d.skip_pin
         FROM devices d
         JOIN families f ON f.id = d.family_id
        WHERE d.token_hash = ? AND d.revoked_at IS NULL AND f.deleted_at IS NULL`,
    )
    .bind(await hashToken(token))
    .first<{
      id: string;
      family_id: string;
      label: string;
      kind: DeviceKind;
      member_id: string | null;
      skip_pin: number;
    }>();
  if (!row) return null;

  return {
    id: row.id,
    familyId: row.family_id,
    label: row.label,
    kind: row.kind,
    memberId: row.member_id,
    skipPin: row.skip_pin === 1,
  };
}

export function touchDevice(db: D1Database, deviceId: string): Promise<unknown> {
  return db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
    .bind(Date.now(), deviceId)
    .run();
}

export async function listDevices(db: D1Database, familyId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, label, kind, member_id, skip_pin, created_at, last_seen_at
         FROM devices
        WHERE family_id = ? AND revoked_at IS NULL
        ORDER BY created_at`,
    )
    .bind(familyId)
    .all<{
      id: string;
      label: string;
      kind: DeviceKind;
      member_id: string | null;
      skip_pin: number;
      created_at: number;
      last_seen_at: number | null;
    }>();

  return results.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    memberId: row.member_id,
    skipPin: row.skip_pin === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

/**
 * 端末の名前を変える。
 * 「リビングのタブレット」を買い替えたり、置き場所が変わったりする。
 * 名前が実態と合っていないと、失効させるときにどれを切ればいいのか分からなくなる。
 */
export async function updateDevice(
  db: D1Database,
  familyId: string,
  deviceId: string,
  patch: { label?: string },
): Promise<DeviceRecord | null> {
  if (patch.label !== undefined) {
    await db
      .prepare(
        "UPDATE devices SET label = ? WHERE family_id = ? AND id = ? AND revoked_at IS NULL",
      )
      .bind(patch.label, familyId, deviceId)
      .run();
  }

  const row = await db
    .prepare(
      `SELECT id, family_id, label, kind, member_id, skip_pin
         FROM devices WHERE family_id = ? AND id = ? AND revoked_at IS NULL`,
    )
    .bind(familyId, deviceId)
    .first<{
      id: string;
      family_id: string;
      label: string;
      kind: DeviceKind;
      member_id: string | null;
      skip_pin: number;
    }>();
  if (!row) return null;

  return {
    id: row.id,
    familyId: row.family_id,
    label: row.label,
    kind: row.kind,
    memberId: row.member_id,
    skipPin: row.skip_pin === 1,
  };
}

export async function revokeDevice(
  db: D1Database,
  familyId: string,
  deviceId: string,
): Promise<void> {
  await db
    .prepare("UPDATE devices SET revoked_at = ? WHERE family_id = ? AND id = ? AND revoked_at IS NULL")
    .bind(Date.now(), familyId, deviceId)
    .run();
}
