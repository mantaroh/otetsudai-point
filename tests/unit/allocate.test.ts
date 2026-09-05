import { describe, expect, it } from "vitest";
import { allocate } from "../../src/worker/db/ledger";

/**
 * シールの割り当ては、このアプリで一番間違えやすいところ。
 *
 * 台帳またぎと、取り消しで空いた穴の埋め戻しの両方をここが引き受けているので、
 * DB を立てずに直接叩いて全パターンを潰しておく。
 */

function start(capacity: number, occupied: number[] = []) {
  return {
    sheetId: "sheet-1",
    seqNo: 1,
    capacity,
    occupied: new Set(occupied),
  };
}

describe("allocate", () => {
  it("空の台帳に1枚貼ると、1マス目に入る", () => {
    const plan = allocate(start(30), 1, 30);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.positions).toEqual([1]);
    expect(plan[0]!.becomesFull).toBe(false);
    expect(plan[0]!.isNew).toBe(false);
  });

  it("複数枚は若いマスから順に埋まる", () => {
    const plan = allocate(start(30), 3, 30);
    expect(plan[0]!.positions).toEqual([1, 2, 3]);
  });

  it("取り消しで空いた穴を、次のシールが埋める", () => {
    // 1〜5 のうち 2 と 4 が取り消された状態
    const plan = allocate(start(30, [1, 3, 5]), 2, 30);
    expect(plan[0]!.positions).toEqual([2, 4]);
  });

  it("穴を埋めきったら、その先の空きマスに続く", () => {
    const plan = allocate(start(30, [1, 3]), 3, 30);
    expect(plan[0]!.positions).toEqual([2, 4, 5]);
  });

  it("ちょうど埋まると満了になる", () => {
    const plan = allocate(start(5, [1, 2, 3, 4]), 1, 5);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.positions).toEqual([5]);
    expect(plan[0]!.becomesFull).toBe(true);
  });

  it("残りより多く貼ると、あふれた分が次の台帳に繰り越される", () => {
    // 残り2マスに3枚 → 2枚で満了、1枚が2冊目へ
    const plan = allocate(start(5, [1, 2, 3]), 3, 5);
    expect(plan).toHaveLength(2);

    expect(plan[0]!.positions).toEqual([4, 5]);
    expect(plan[0]!.becomesFull).toBe(true);
    expect(plan[0]!.isNew).toBe(false);

    expect(plan[1]!.positions).toEqual([1]);
    expect(plan[1]!.becomesFull).toBe(false);
    expect(plan[1]!.isNew).toBe(true);
    expect(plan[1]!.seqNo).toBe(2);
  });

  it("繰り越し先の台帳は、新しい ID になる", () => {
    const plan = allocate(start(5, [1, 2, 3, 4]), 2, 5);
    expect(plan[1]!.sheetId).not.toBe(plan[0]!.sheetId);
  });

  it("2冊以上またぐ場合も、通し番号が連続する", () => {
    // 空の5マス台帳に12枚 → 5 + 5 + 2
    const plan = allocate(start(5), 12, 5);
    expect(plan.map((entry) => entry.positions.length)).toEqual([5, 5, 2]);
    expect(plan.map((entry) => entry.seqNo)).toEqual([1, 2, 3]);
    expect(plan.map((entry) => entry.becomesFull)).toEqual([true, true, false]);
    expect(plan.map((entry) => entry.isNew)).toEqual([false, true, true]);
  });

  it("繰り越しの境目がちょうどの場合、最後の台帳も満了になる", () => {
    const plan = allocate(start(5), 10, 5);
    expect(plan).toHaveLength(2);
    expect(plan.every((entry) => entry.becomesFull)).toBe(true);
  });

  it("すでに満了している台帳から始まっても、無限ループにならない", () => {
    // 取り消しと再付与が競合した直後などに起こりうる
    const plan = allocate(start(3, [1, 2, 3]), 2, 3);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.positions).toEqual([]);
    expect(plan[0]!.becomesFull).toBe(true);
    expect(plan[1]!.positions).toEqual([1, 2]);
  });

  it("繰り越し先のマス数には、いまの家庭の設定が使われる", () => {
    // 台帳のマス数を 5 から 10 に変えた直後。古い台帳は5のまま、次の台帳から10になる
    const plan = allocate(start(5, [1, 2, 3, 4]), 4, 10);
    expect(plan[0]!.capacity).toBe(5);
    expect(plan[1]!.capacity).toBe(10);
    expect(plan[1]!.positions).toEqual([1, 2, 3]);
    expect(plan[1]!.becomesFull).toBe(false);
  });

  it("マス数が 0 以下なら、黙って進まずに落とす", () => {
    expect(() => allocate(start(0), 1, 30)).toThrow();
    expect(() => allocate(start(30), 1, 0)).toThrow();
  });
});
