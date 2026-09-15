import type { Family, FamilySettings, Member, MembershipRole } from "../../shared/types";
import { hashPin, verifyPin } from "../lib/crypto";
import { newId } from "../lib/ids";

/**
 * 家庭・メンバー・設定まわりの DB アクセス。
 *
 * このモジュール(と db/ 配下の全モジュール)の規約:
 *   家庭に属するデータを触る関数は、必ず familyId を第一引数に取り、
 *   SQL に WHERE family_id = ? を含める。呼び出し側の都合で省略しない。
 */

// ── 型 ────────────────────────────────────────

interface MemberRow {
  id: string;
  name: string;
  role: "child" | "parent";
  avatar: string | null;
  color: string | null;
  sort_order: number;
}

interface SettingsRow {
  capacity: number;
  require_approval: number;
  allow_self_grant: number;
  self_revoke_sec: number;
  siblings_visible: number;
  sticker_theme: string;
  ui_log_days: number;
}

export function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    color: row.color,
    sortOrder: row.sort_order,
  };
}

function toSettings(row: SettingsRow): FamilySettings {
  return {
    capacity: row.capacity,
    requireApproval: row.require_approval === 1,
    allowSelfGrant: row.allow_self_grant === 1,
    selfRevokeSec: row.self_revoke_sec,
    siblingsVisible: row.siblings_visible === 1,
    stickerTheme: row.sticker_theme,
    uiLogDays: row.ui_log_days,
  };
}

// ── ユーザー・所属 ────────────────────────────

export interface UserIdentity {
  provider: string;
  subject: string;
  email: string | null;
  displayName: string | null;
}

export async function findOrCreateUser(db: D1Database, identity: UserIdentity): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM users WHERE provider = ? AND subject = ?")
    .bind(identity.provider, identity.subject)
    .first<{ id: string }>();
  if (existing) {
    // 表示名やメールは変わりうるので追随させる
    await db
      .prepare("UPDATE users SET email = ?, display_name = ? WHERE id = ?")
      .bind(identity.email, identity.displayName, existing.id)
      .run();
    return existing.id;
  }

  const id = newId("usr");
  await db
    .prepare(
      "INSERT INTO users (id, provider, subject, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, identity.provider, identity.subject, identity.email, identity.displayName, Date.now())
    .run();
  return id;
}

export async function getUser(db: D1Database, userId: string) {
  return db
    .prepare("SELECT id, display_name, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; display_name: string | null; email: string | null }>();
}

export async function listFamiliesForUser(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, m.role
         FROM memberships m
         JOIN families f ON f.id = m.family_id
        WHERE m.user_id = ? AND f.deleted_at IS NULL
        ORDER BY m.joined_at`,
    )
    .bind(userId)
    .all<{ id: string; name: string; role: MembershipRole }>();
  return results;
}

export async function getMembership(db: D1Database, userId: string, familyId: string) {
  return db
    .prepare(
      `SELECT m.role, m.member_id
         FROM memberships m
         JOIN families f ON f.id = m.family_id
        WHERE m.user_id = ? AND m.family_id = ? AND f.deleted_at IS NULL`,
    )
    .bind(userId, familyId)
    .first<{ role: MembershipRole; member_id: string | null }>();
}

// ── 家庭 ──────────────────────────────────────

export async function getFamily(db: D1Database, familyId: string): Promise<Family | null> {
  const row = await db
    .prepare("SELECT id, name FROM families WHERE id = ? AND deleted_at IS NULL")
    .bind(familyId)
    .first<{ id: string; name: string }>();
  return row ? { id: row.id, name: row.name } : null;
}

export async function getSettings(db: D1Database, familyId: string): Promise<FamilySettings | null> {
  const row = await db
    .prepare(
      `SELECT capacity, require_approval, allow_self_grant, self_revoke_sec,
              siblings_visible, sticker_theme, ui_log_days
         FROM family_settings WHERE family_id = ?`,
    )
    .bind(familyId)
    .first<SettingsRow>();
  return row ? toSettings(row) : null;
}

/**
 * 集計を家庭のカレンダーで区切るために使う。
 * FamilySettings には載せていない(画面から変える項目ではない)ので、単独で引く。
 */
export async function getTimeZone(db: D1Database, familyId: string): Promise<string> {
  const row = await db
    .prepare("SELECT timezone FROM family_settings WHERE family_id = ?")
    .bind(familyId)
    .first<{ timezone: string }>();
  return row?.timezone ?? "UTC";
}

const SETTING_COLUMNS: Record<keyof FamilySettings, string> = {
  capacity: "capacity",
  requireApproval: "require_approval",
  allowSelfGrant: "allow_self_grant",
  selfRevokeSec: "self_revoke_sec",
  siblingsVisible: "siblings_visible",
  stickerTheme: "sticker_theme",
  uiLogDays: "ui_log_days",
};

export async function updateSettings(
  db: D1Database,
  familyId: string,
  patch: Partial<FamilySettings>,
): Promise<void> {
  const assignments: string[] = [];
  const values: Array<string | number> = [];
  for (const [key, column] of Object.entries(SETTING_COLUMNS)) {
    const value = patch[key as keyof FamilySettings];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  if (assignments.length === 0) return;
  await db
    .prepare(`UPDATE family_settings SET ${assignments.join(", ")} WHERE family_id = ?`)
    .bind(...values, familyId)
    .run();
}

// ── メンバー ──────────────────────────────────

export async function listMembers(db: D1Database, familyId: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, role, avatar, color, sort_order
         FROM members WHERE family_id = ? AND archived_at IS NULL
        ORDER BY sort_order, name`,
    )
    .bind(familyId)
    .all<MemberRow>();
  return results.map(toMember);
}

export async function getMember(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<Member | null> {
  const row = await db
    .prepare(
      `SELECT id, name, role, avatar, color, sort_order
         FROM members WHERE family_id = ? AND id = ? AND archived_at IS NULL`,
    )
    .bind(familyId, memberId)
    .first<MemberRow>();
  return row ? toMember(row) : null;
}

/**
 * しまってある人も含めて引く。
 * 「戻す」「完全に削除する」は、しまってある人にこそ使うので、
 * 通常の getMember(活動中のみ)では見つけられない。
 */
export async function getAnyMember(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<{ member: Member; archived: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT id, name, role, avatar, color, sort_order, archived_at
         FROM members WHERE family_id = ? AND id = ?`,
    )
    .bind(familyId, memberId)
    .first<MemberRow & { archived_at: number | null }>();
  return row ? { member: toMember(row), archived: row.archived_at !== null } : null;
}

export async function listArchivedMembers(db: D1Database, familyId: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, role, avatar, color, sort_order
         FROM members WHERE family_id = ? AND archived_at IS NOT NULL
        ORDER BY archived_at DESC`,
    )
    .bind(familyId)
    .all<MemberRow>();
  return results.map(toMember);
}

export interface CreateMemberInput {
  name: string;
  role: "child" | "parent";
  avatar: string | null;
  color: string | null;
  /** 子どもを追加したときに発行する台帳のマス数 */
  capacity: number;
}

/**
 * メンバーを増やす。
 * 子どもなら、その場で1冊目の台帳も発行する(追加した直後から貼れる状態にする)。
 */
export async function createMember(
  db: D1Database,
  familyId: string,
  input: CreateMemberInput,
): Promise<Member | null> {
  const now = Date.now();
  const memberId = newId("mem");

  const order = await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM members WHERE family_id = ?")
    .bind(familyId)
    .first<{ n: number }>();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO members (id, family_id, name, role, avatar, color, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        memberId,
        familyId,
        input.name,
        input.role,
        input.avatar,
        input.color,
        (order?.n ?? 0) + 1,
        now,
      ),
  ];

  if (input.role === "child") {
    statements.push(
      db
        .prepare(
          `INSERT INTO sheets (id, family_id, member_id, seq_no, capacity, status, started_at)
           VALUES (?, ?, ?, 1, ?, 'active', ?)`,
        )
        .bind(newId("sht"), familyId, memberId, input.capacity, now),
    );
  }

  await db.batch(statements);
  return getMember(db, familyId, memberId);
}

/**
 * そのメンバーが、記録のどこかに現れるか。
 *
 * 自分の台帳のシールだけでなく、「誰が貼ったか」「誰がハンコを押したか」も含める。
 * 記録から参照されている人を消すと履歴が壊れるので、完全削除はここが偽のときだけ許す
 * (スキーマの外部キーからしても、参照が残ったままでは行を消せない)。
 */
export async function memberHasRecords(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM grants
           WHERE family_id = ?1
             AND (member_id = ?2 OR created_by = ?2 OR approved_by = ?2 OR revoked_by = ?2)) +
         (SELECT COUNT(*) FROM redemptions
           WHERE family_id = ?1 AND (member_id = ?2 OR approved_by = ?2)) +
         (SELECT COUNT(*) FROM stickers st
            JOIN sheets sh ON sh.id = st.sheet_id
           WHERE st.family_id = ?1 AND sh.member_id = ?2)
       AS n`,
    )
    .bind(familyId, memberId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/** 同じ役割で、いま活動しているメンバーの数 */
export async function countActiveMembers(
  db: D1Database,
  familyId: string,
  role: "child" | "parent",
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM members WHERE family_id = ? AND role = ? AND archived_at IS NULL",
    )
    .bind(familyId, role)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 一覧から外す。記録は残るので、あとから戻せる */
export async function archiveMember(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<void> {
  await db
    .prepare("UPDATE members SET archived_at = ? WHERE family_id = ? AND id = ? AND archived_at IS NULL")
    .bind(Date.now(), familyId, memberId)
    .run();
}

export async function restoreMember(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<Member | null> {
  await db
    .prepare("UPDATE members SET archived_at = NULL WHERE family_id = ? AND id = ?")
    .bind(familyId, memberId)
    .run();
  return getMember(db, familyId, memberId);
}

/**
 * 完全に消す。
 * 記録が1件でもあるメンバーには使わせない(呼び出し側で弾く)ので、
 * ここで消えるのは台帳の器と、その人に紐づいた端末だけ。
 */
export async function purgeMember(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<void> {
  await db.batch([
    // その子専用として配った端末は、行き場が無くなるので失効させる。
    // 参照(member_id)も外す。残したままだと、メンバーの行を消せない
    db
      .prepare(
        "UPDATE devices SET revoked_at = ?, member_id = NULL WHERE family_id = ? AND member_id = ?",
      )
      .bind(Date.now(), familyId, memberId),
    db
      .prepare("UPDATE device_invites SET member_id = NULL WHERE family_id = ? AND member_id = ?")
      .bind(familyId, memberId),
    db
      .prepare("UPDATE memberships SET member_id = NULL WHERE family_id = ? AND member_id = ?")
      .bind(familyId, memberId),
    db
      .prepare("UPDATE chores SET created_by = NULL WHERE family_id = ? AND created_by = ?")
      .bind(familyId, memberId),
    // 操作記録は「記録が残っている」の判定には数えない(操作ログがあるだけで
    // 完全削除を止めるのは行き過ぎ)。参照だけ外して、集計上は誰のものでもなくする
    db
      .prepare("UPDATE ui_events SET member_id = NULL WHERE family_id = ? AND member_id = ?")
      .bind(familyId, memberId),
    db.prepare("DELETE FROM sheets WHERE family_id = ? AND member_id = ?").bind(familyId, memberId),
    db.prepare("DELETE FROM members WHERE family_id = ? AND id = ?").bind(familyId, memberId),
  ]);
}

export interface MemberPatch {
  name?: string;
  avatar?: string | null;
  color?: string | null;
}

/**
 * メンバーの表示情報を変える。
 *
 * 名前は ID ではなく表示のためだけに持っているので、変えると過去の履歴の表示も
 * 新しい名前になる。これは意図した挙動。
 * (お手伝いの名前は `grants.chore_label` に凍結してある。「何をしたか」は
 *  後から書き換わってはいけないが、「誰か」は同じ人のままなので追随してよい)
 */
export async function updateMember(
  db: D1Database,
  familyId: string,
  memberId: string,
  patch: MemberPatch,
): Promise<Member | null> {
  const assignments: string[] = [];
  const values: Array<string | null> = [];

  if (patch.name !== undefined) {
    assignments.push("name = ?");
    values.push(patch.name);
  }
  if (patch.avatar !== undefined) {
    assignments.push("avatar = ?");
    values.push(patch.avatar);
  }
  if (patch.color !== undefined) {
    assignments.push("color = ?");
    values.push(patch.color);
  }
  if (assignments.length === 0) return getMember(db, familyId, memberId);

  await db
    .prepare(
      `UPDATE members SET ${assignments.join(", ")}
        WHERE family_id = ? AND id = ? AND archived_at IS NULL`,
    )
    .bind(...values, familyId, memberId)
    .run();

  return getMember(db, familyId, memberId);
}

/**
 * 親操作を「誰の名前で」記録するかを決める。
 * OAuth ユーザーは自分に紐づく member、共有端末からの PIN 操作は家庭の代表の親。
 */
export async function resolveParentMemberId(
  db: D1Database,
  familyId: string,
  preferred: string | null,
): Promise<string | null> {
  if (preferred) {
    const member = await getMember(db, familyId, preferred);
    if (member?.role === "parent") return member.id;
  }
  const row = await db
    .prepare(
      `SELECT id FROM members
        WHERE family_id = ? AND role = 'parent' AND archived_at IS NULL
        ORDER BY sort_order, name LIMIT 1`,
    )
    .bind(familyId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ── PIN ───────────────────────────────────────

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

export type PinResult = { ok: true } | { ok: false; lockedUntil: number | null };

/**
 * 親 PIN の検証。総当たり対策として、家庭単位で失敗回数を数えてロックする。
 */
export async function checkFamilyPin(
  db: D1Database,
  familyId: string,
  pin: string,
  pepper: string,
): Promise<PinResult> {
  const row = await db
    .prepare(
      "SELECT pin_hash, pin_failed_count, pin_locked_until FROM families WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(familyId)
    .first<{ pin_hash: string; pin_failed_count: number; pin_locked_until: number | null }>();
  if (!row) return { ok: false, lockedUntil: null };

  const now = Date.now();
  if (row.pin_locked_until && row.pin_locked_until > now) {
    return { ok: false, lockedUntil: row.pin_locked_until };
  }

  if (await verifyPin(pin, row.pin_hash, pepper)) {
    if (row.pin_failed_count > 0 || row.pin_locked_until) {
      await db
        .prepare("UPDATE families SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?")
        .bind(familyId)
        .run();
    }
    return { ok: true };
  }

  const failed = row.pin_failed_count + 1;
  const lockedUntil = failed >= PIN_MAX_ATTEMPTS ? now + PIN_LOCK_MS : null;
  await db
    .prepare("UPDATE families SET pin_failed_count = ?, pin_locked_until = ? WHERE id = ?")
    .bind(lockedUntil ? 0 : failed, lockedUntil, familyId)
    .run();
  return { ok: false, lockedUntil };
}

export async function setFamilyPin(
  db: D1Database,
  familyId: string,
  pin: string,
  pepper: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE families SET pin_hash = ?, pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?",
    )
    .bind(await hashPin(pin, pepper), familyId)
    .run();
}

// ── 家庭の新規作成(オンボーディング) ─────────

/** 初回に入っているお手伝いメニュー。家庭ごとに自由に足し引きされる前提の、ただの種。 */
const DEFAULT_CHORES: Array<{ name: string; emoji: string }> = [
  { name: "しょっきをあらう", emoji: "🍽️" },
  { name: "せんたくものをたたむ", emoji: "🧺" },
  { name: "おふろそうじ", emoji: "🛁" },
  { name: "そうじき", emoji: "🧹" },
  { name: "ゴミすて", emoji: "🗑️" },
  { name: "げんかんのくつをそろえる", emoji: "👟" },
  { name: "ごはんのじゅんび", emoji: "🍚" },
  { name: "おかたづけ", emoji: "🧸" },
];

export function normalizeChoreName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface CreateFamilyInput {
  familyName: string;
  pin: string;
  parentName: string;
  children: Array<{ name: string; avatar?: string; color?: string }>;
  capacity: number;
  userId: string;
  /** PIN のハッシュ化に混ぜるサーバ側の秘密鍵 */
  pepper: string;
}

export async function createFamily(
  db: D1Database,
  input: CreateFamilyInput,
): Promise<{ familyId: string; parentMemberId: string }> {
  const now = Date.now();
  const familyId = newId("fam");
  const parentMemberId = newId("mem");
  const pinHash = await hashPin(input.pin, input.pepper);

  const statements: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO families (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(familyId, input.familyName, pinHash, now),
    db
      .prepare("INSERT INTO family_settings (family_id, capacity) VALUES (?, ?)")
      .bind(familyId, input.capacity),
    db
      .prepare(
        `INSERT INTO members (id, family_id, name, role, avatar, color, sort_order, created_at)
         VALUES (?, ?, ?, 'parent', ?, ?, 0, ?)`,
      )
      .bind(parentMemberId, familyId, input.parentName, "👤", "#7c6f5a", now),
    db
      .prepare(
        "INSERT INTO memberships (user_id, family_id, role, member_id, joined_at) VALUES (?, ?, 'owner', ?, ?)",
      )
      .bind(input.userId, familyId, parentMemberId, now),
  ];

  input.children.forEach((child, index) => {
    const memberId = newId("mem");
    statements.push(
      db
        .prepare(
          `INSERT INTO members (id, family_id, name, role, avatar, color, sort_order, created_at)
           VALUES (?, ?, ?, 'child', ?, ?, ?, ?)`,
        )
        .bind(
          memberId,
          familyId,
          child.name,
          child.avatar ?? "🙂",
          child.color ?? CHILD_COLORS[index % CHILD_COLORS.length]!,
          index + 1,
          now,
        ),
      // 最初の台帳をこの場で発行しておく(子が開いた瞬間に貼れる状態にする)
      db
        .prepare(
          `INSERT INTO sheets (id, family_id, member_id, seq_no, capacity, status, started_at)
           VALUES (?, ?, ?, 1, ?, 'active', ?)`,
        )
        .bind(newId("sht"), familyId, memberId, input.capacity, now),
    );
  });

  // 並び順は種のリストの順にする。全部 0 にすると同点が名前順で決まり、
  // 名前を直しただけでボタンの位置が動いてしまう。
  DEFAULT_CHORES.forEach((chore, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO chores (id, family_id, name, name_norm, emoji, default_count, created_by, created_at, sort_order)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          newId("cho"),
          familyId,
          chore.name,
          normalizeChoreName(chore.name),
          chore.emoji,
          parentMemberId,
          now,
          index,
        ),
    );
  });

  await db.batch(statements);
  return { familyId, parentMemberId };
}

const CHILD_COLORS = ["#ff8fab", "#5bc0eb", "#9bc53d", "#fa9f42", "#a06cd5"];
