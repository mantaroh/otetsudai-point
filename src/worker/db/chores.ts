import type { Chore } from "../../shared/types";
import { conflict } from "../lib/errors";
import { newId } from "../lib/ids";
import { normalizeChoreName } from "./family";

/**
 * お手伝いメニュー。
 * 「そのほか」で自由入力されたものは、その場でメニューに追加され、
 * 以後は兄弟どちらの選択肢にも出る(家族共通のマスター)。
 *
 * 並び順は親が決める(sort_order、小さいほど上)。使用頻度では動かさない。
 * 子どもから見て、毎回同じ位置に同じボタンがあるほうが使い慣れるため。
 */

interface ChoreRow {
  id: string;
  name: string;
  emoji: string | null;
  default_count: number;
  use_count: number;
  last_used_at: number | null;
  sort_order: number;
}

const CHORE_COLUMNS = "id, name, emoji, default_count, use_count, last_used_at, sort_order";

/**
 * その家庭でいちばん上に来る sort_order。今の最小値より1小さくする。
 * 全体を振り直さずに済むので、足すのは1行の書き込みで終わる。
 * アーカイブ済みの行も最小値の計算に含めるが、どのみち使われている行より上になる。
 */
const TOP_SORT_ORDER = "(SELECT COALESCE(MIN(sort_order), 0) - 1 FROM chores WHERE family_id = ?)";

function toChore(row: ChoreRow): Chore {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    defaultCount: row.default_count,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    sortOrder: row.sort_order,
  };
}

export async function listChores(db: D1Database, familyId: string): Promise<Chore[]> {
  // name は、sort_order が万一重複したときに順を決めるためだけのもの
  const { results } = await db
    .prepare(
      `SELECT ${CHORE_COLUMNS}
         FROM chores
        WHERE family_id = ? AND archived_at IS NULL
        ORDER BY sort_order, name`,
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
    .prepare(`SELECT ${CHORE_COLUMNS} FROM chores WHERE family_id = ? AND id = ?`)
    .bind(familyId, choreId)
    .first<ChoreRow>();
  return row ? toChore(row) : null;
}

/**
 * 名前からメニューを引き当てる。無ければ作る。
 *
 * 表記ゆれ(全半角・前後空白・大文字小文字)は name_norm に正規化してから
 * 突き合わせるので、「食器を洗う」と「 食器を洗う 」は同じ1件にマージされる。
 *
 * 新しく作ったものは一番上に置く。
 * すでにある名前だった場合、使われているものは動かさない(子が既存の名前を打っただけ)。
 * アーカイブ済みだったものは復活させて一番上へ戻す(親から見れば足し直したことになる)。
 * SET の右辺はすべて更新前の値で評価されるので、CASE の archived_at は復活前の状態を見ている。
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
      `INSERT INTO chores (id, family_id, name, name_norm, emoji, default_count, created_by, created_at, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ${TOP_SORT_ORDER})
       ON CONFLICT (family_id, name_norm)
       DO UPDATE SET
         sort_order  = CASE WHEN archived_at IS NOT NULL THEN excluded.sort_order ELSE sort_order END,
         archived_at = NULL
       RETURNING ${CHORE_COLUMNS}`,
    )
    .bind(newId("cho"), familyId, trimmed, norm, emoji, createdBy, Date.now(), familyId)
    .first<ChoreRow>();
  if (!row) throw new Error("chore upsert returned no row");
  return toChore(row);
}

/**
 * 並び順を、画面に見えている順のまま丸ごと振り直す。
 *
 * 隣と入れ替えるのではなく全体を送ってもらうのは、「今どう並んでいるか」について
 * 画面とサーバの認識がずれないようにするため。
 *
 * 送られてきた ID が、その家庭のアーカイブされていないお手伝い全部と過不足なく
 * 一致しなければ断る。親が並べ替えている間に子が「そのほか」で1件足した、が
 * 一番ありそうなケースで、そのまま振り直すと足された1件だけ番号が付かずに残る。
 * 他の家庭の ID が混ざっていた場合も一致しないので同じく断る(存在の有無を漏らさない)。
 */
export async function reorderChores(
  db: D1Database,
  familyId: string,
  choreIds: string[],
): Promise<Chore[]> {
  const { results } = await db
    .prepare("SELECT id FROM chores WHERE family_id = ? AND archived_at IS NULL")
    .bind(familyId)
    .all<{ id: string }>();
  const active = new Set(results.map((row) => row.id));
  const given = new Set(choreIds);

  const matches =
    given.size === choreIds.length && // 同じ ID が2回入っていない
    given.size === active.size &&
    choreIds.every((id) => active.has(id));
  if (!matches) throw conflict("お手伝いメニューが変わっています。読み込み直してください");

  await db.batch(
    choreIds.map((id, index) =>
      db
        .prepare("UPDATE chores SET sort_order = ? WHERE family_id = ? AND id = ?")
        .bind(index, familyId, id),
    ),
  );
  return listChores(db, familyId);
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
    if (!patch.archived) {
      // アーカイブから戻したものは一番上へ。ただし、もともとアーカイブされていない行は動かさない。
      // 画面の編集は archived: false を付けて送ってくることがあり、そのたびに上へ飛ぶと困る。
      assignments.push(`sort_order = CASE WHEN archived_at IS NOT NULL THEN ${TOP_SORT_ORDER} ELSE sort_order END`);
      values.push(familyId);
    }
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
