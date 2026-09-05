import type { BonusRule } from "../../shared/types";
import { dayOfMonthOf, weekdayOf } from "../lib/day";

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
