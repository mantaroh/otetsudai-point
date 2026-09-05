import { describe, expect, it } from "vitest";
import type { BonusRule } from "../../src/shared/types";
import { multiplierFor } from "../../src/worker/db/bonus";

function rule(overrides: Partial<BonusRule>): BonusRule {
  return {
    id: "bns_1",
    kind: "once",
    onDate: null,
    weekday: null,
    dayOfMonth: null,
    multiplier: 2,
    createdAt: 1,
    ...overrides,
  };
}

// 2026-09-05 は土曜、2026-09-06 は日曜

describe("multiplierFor", () => {
  it("ルールが無ければ1倍", () => {
    expect(multiplierFor([], "2026-09-05")).toBe(1);
  });

  it("その日の単発ルールが当たる", () => {
    const rules = [rule({ kind: "once", onDate: "2026-09-05" })];
    expect(multiplierFor(rules, "2026-09-05")).toBe(2);
    expect(multiplierFor(rules, "2026-09-06")).toBe(1);
  });

  it("毎週日曜のルールが日曜だけ当たる", () => {
    const rules = [rule({ kind: "weekly", weekday: 0 })];
    expect(multiplierFor(rules, "2026-09-06")).toBe(2);
    expect(multiplierFor(rules, "2026-09-05")).toBe(1);
  });

  it("毎月9日のルールが9日だけ当たる", () => {
    const rules = [rule({ kind: "monthly", dayOfMonth: 9 })];
    expect(multiplierFor(rules, "2026-09-09")).toBe(2);
    expect(multiplierFor(rules, "2026-09-10")).toBe(1);
  });

  it("毎月31日は、31日がない月には当たらない", () => {
    const rules = [rule({ kind: "monthly", dayOfMonth: 31 })];
    expect(multiplierFor(rules, "2026-10-31")).toBe(2);
    // 2026-09 は30日まで。月末に丸めない
    expect(multiplierFor(rules, "2026-09-30")).toBe(1);
  });

  it("複数当たったら大きいほうを採る", () => {
    const rules = [
      rule({ id: "bns_a", kind: "weekly", weekday: 6, multiplier: 2 }),
      rule({ id: "bns_b", kind: "once", onDate: "2026-09-05", multiplier: 3 }),
    ];
    expect(multiplierFor(rules, "2026-09-05")).toBe(3);
  });
});
