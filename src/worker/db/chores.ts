import type { Chore } from "../../shared/types";
import { newId } from "../lib/ids";
import { normalizeChoreName } from "./family";

/**
 * お手伝いメニュー。
 * 「そのほか」で自由入力されたものは、その場でメニューに追加され、
 * 以後は兄弟どちらの選択肢にも出る(家族共通のマスター)。
 */

interface ChoreRow {
  id: string;
  name: string;
  emoji: string | null;
  default_count: number;
  use_count: number;
  last_used_at: number | null;
}

function toChore(row: ChoreRow): Chore {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    defaultCount: row.default_count,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
  };
}

export async function listChores(db: D1Database, familyId: string): Promise<Chore[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, emoji, default_count, use_count, last_used_at
         FROM chores
        WHERE family_id = ? AND archived_at IS NULL
        ORDER BY use_count DESC, last_used_at DESC, name`,
    )
    .bind(familyId)
    .all<ChoreRow>();
  return results.map(toChore);
}

export async function getChore(
  db: D1Database,
  familyId: string,
  choreId: string,
): Promise<Chore | null> {
  const row = await db
    .prepare(
      `SELECT id, name, emoji, default_count, use_count, last_used_at
         FROM chores WHERE family_id = ? AND id = ?`,
    )
    .bind(familyId, choreId)
    .first<ChoreRow>();
  return row ? toChore(row) : null;
}

/**
 * 名前からメニューを引き当てる。無ければ作る。
 *
 * 表記ゆれ(全半角・前後空白・大文字小文字)は name_norm に正規化してから
 * 突き合わせるので、「食器を洗う」と「 食器を洗う 」は同じ1件にマージされる。
 * アーカイブ済みの名前が再入力されたら復活させる。
 */
export async function upsertChoreByName(
  db: D1Database,
  familyId: string,
  name: string,
  createdBy: string | null,
  emoji: string | null = null,
): Promise<Chore> {
  const trimmed = name.trim();
  const norm = normalizeChoreName(trimmed);
  const row = await db
    .prepare(
      `INSERT INTO chores (id, family_id, name, name_norm, emoji, default_count, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (family_id, name_norm)
       DO UPDATE SET archived_at = NULL
       RETURNING id, name, emoji, default_count, use_count, last_used_at`,
    )
    .bind(newId("cho"), familyId, trimmed, norm, emoji, createdBy, Date.now())
    .first<ChoreRow>();
  if (!row) throw new Error("chore upsert returned no row");
  return toChore(row);
}

export interface ChorePatch {
  name?: string;
  emoji?: string | null;
  defaultCount?: number;
  archived?: boolean;
}

export async function updateChore(
  db: D1Database,
  familyId: string,
  choreId: string,
  patch: ChorePatch,
): Promise<Chore | null> {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];

  if (patch.name !== undefined) {
    assignments.push("name = ?", "name_norm = ?");
    values.push(patch.name.trim(), normalizeChoreName(patch.name));
  }
  if (patch.emoji !== undefined) {
    assignments.push("emoji = ?");
    values.push(patch.emoji);
  }
  if (patch.defaultCount !== undefined) {
    assignments.push("default_count = ?");
    values.push(patch.defaultCount);
  }
  if (patch.archived !== undefined) {
    assignments.push("archived_at = ?");
    values.push(patch.archived ? Date.now() : null);
  }
  if (assignments.length === 0) return getChore(db, familyId, choreId);

  await db
    .prepare(`UPDATE chores SET ${assignments.join(", ")} WHERE family_id = ? AND id = ?`)
    .bind(...values, familyId, choreId)
    .run();
  return getChore(db, familyId, choreId);
}
