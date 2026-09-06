import type { BonusRule, BonusRuleInput, BonusState } from "../../shared/types";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { dayKey, dayOfMonthOf, weekdayOf } from "../lib/day";
import { getTimeZone } from "./family";

/**
 * ポイント2倍デー。
 *
 * 単発（今日だけ）も定期（毎週日曜・毎月9日）も bonus_rules の1行として持つ。
 * 「今日だけ2倍」は kind='once' の行を1つ入れることと同じ。
 *
 * 評価は DB を触らない純関数に切り出してある。曜日・月末の扱いは
 * 単体テストで固めておきたいところで、ここが一番間違えやすい。
 */

/** 該当するルールが無ければ 1。複数当たったら大きいほうを採る。 */
export function multiplierFor(rules: BonusRule[], key: string): number {
  const weekday = weekdayOf(key);
  const dayOfMonth = dayOfMonthOf(key);

  let best = 1;
  for (const rule of rules) {
    const hit =
      (rule.kind === "once" && rule.onDate === key) ||
      (rule.kind === "weekly" && rule.weekday === weekday) ||
      // 毎月31日は、31日がない月にはそもそも当たらない。月末に丸めない。
      (rule.kind === "monthly" && rule.dayOfMonth === dayOfMonth);
    if (hit && rule.multiplier > best) best = rule.multiplier;
  }
  return best;
}

// ── 行の型とマッパ ─────────────────────────────

interface BonusRuleRow {
  id: string;
  kind: "once" | "weekly" | "monthly";
  on_date: string | null;
  weekday: number | null;
  day_of_month: number | null;
  multiplier: number;
  created_at: number;
}

const RULE_COLUMNS = `id, kind, on_date, weekday, day_of_month, multiplier, created_at`;

function toRule(row: BonusRuleRow): BonusRule {
  return {
    id: row.id,
    kind: row.kind,
    onDate: row.on_date,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    multiplier: row.multiplier,
    createdAt: row.created_at,
  };
}

// ── 読み取り ──────────────────────────────────

export async function listRules(db: D1Database, familyId: string): Promise<BonusRule[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM bonus_rules
        WHERE family_id = ? AND disabled_at IS NULL
        ORDER BY kind, weekday, day_of_month, on_date`,
    )
    .bind(familyId)
    .all<BonusRuleRow>();
  return results.map(toRule);
}

/** 今日の状態。理由（source）も返す。定期で2倍の日はトグルを押せなくするために使う。 */
export async function getState(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);
  const rules = await listRules(db, familyId);
  const multiplier = multiplierFor(rules, key);

  if (multiplier <= 1) {
    return { active: false, multiplier: 1, source: "none", dayKey: key };
  }

  // 単発があればそれを理由にする。取り消せるのは単発だけなので、そちらを優先して見せる。
  const weekday = weekdayOf(key);
  const source = rules.some((rule) => rule.kind === "once" && rule.onDate === key)
    ? "once"
    : rules.some((rule) => rule.kind === "weekly" && rule.weekday === weekday)
      ? "weekly"
      : "monthly";

  return { active: true, multiplier, source, dayKey: key };
}

/** シールを貼るときの倍率。該当が無ければ 1。 */
export async function resolveMultiplier(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<number> {
  const timeZone = await getTimeZone(db, familyId);
  const rules = await listRules(db, familyId);
  return multiplierFor(rules, dayKey(at, timeZone));
}

// ── 書き込み ──────────────────────────────────

/** 今日を2倍にする。すでに2倍なら何もしない（同じ結果を返す）。 */
export async function enableToday(
  db: D1Database,
  familyId: string,
  at: number,
  createdBy: string | null,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);

  // 部分ユニークインデックスがあるので、二重に押されても1行しか入らない
  await db
    .prepare(
      `INSERT OR IGNORE INTO bonus_rules
         (id, family_id, kind, on_date, multiplier, created_by, created_at)
       VALUES (?, ?, 'once', ?, 2, ?, ?)`,
    )
    .bind(newId("bns"), familyId, key, createdBy, at)
    .run();

  return getState(db, familyId, at);
}

/**
 * 今日の単発ルールを無効化する。
 *
 * 定期ルールで2倍になっている日はここでは戻せない。
 * 戻したいときは定期ルールそのものを消す。
 */
export async function disableToday(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);

  await db
    .prepare(
      `UPDATE bonus_rules SET disabled_at = ?
        WHERE family_id = ? AND kind = 'once' AND on_date = ? AND disabled_at IS NULL`,
    )
    .bind(at, familyId, key)
    .run();

  return getState(db, familyId, at);
}

export async function addRule(
  db: D1Database,
  familyId: string,
  input: BonusRuleInput,
  createdBy: string | null,
): Promise<BonusRule> {
  const id = newId("bns");
  const now = Date.now();
  const weekday = input.kind === "weekly" ? input.weekday : null;
  const dayOfMonth = input.kind === "monthly" ? input.dayOfMonth : null;

  // OR IGNORE は UNIQUE 違反だけでなく CHECK 違反も黙って無視する。
  // なので weekday/dayOfMonth の範囲チェックはここでは行わず、API 境界(asInt)で先に弾く前提。
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO bonus_rules
         (id, family_id, kind, weekday, day_of_month, multiplier, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 2, ?, ?)`,
    )
    .bind(id, familyId, input.kind, weekday, dayOfMonth, createdBy, now)
    .run();

  // IGNORE された = 同じ設定が既にある
  if (result.meta.changes === 0) throw conflict("同じ設定がすでにあります");

  return {
    id,
    kind: input.kind,
    onDate: null,
    weekday,
    dayOfMonth,
    multiplier: 2,
    createdAt: now,
  };
}

export async function removeRule(
  db: D1Database,
  familyId: string,
  ruleId: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE bonus_rules SET disabled_at = ?
        WHERE family_id = ? AND id = ? AND disabled_at IS NULL`,
    )
    .bind(Date.now(), familyId, ruleId)
    .run();
  if (result.meta.changes === 0) throw notFound("その設定は見つかりませんでした");
}
