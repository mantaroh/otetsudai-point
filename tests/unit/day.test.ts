import { describe, expect, it } from "vitest";
import { dayKey, dayOfMonthOf, localHour, weekdayOf } from "../../src/worker/lib/day";

/**
 * 2倍デーの判定は「家庭のローカル日付」で行う。
 * ここがずれると、23時台に貼ったシールが翌日扱いになる。
 */

const JST = "Asia/Tokyo";

describe("dayKey", () => {
  it("JST の 23:59 はその日のまま", () => {
    // 2026-09-05 23:59:59 JST = 2026-09-05 14:59:59 UTC
    expect(dayKey(Date.UTC(2026, 8, 5, 14, 59, 59), JST)).toBe("2026-09-05");
  });

  it("JST の 00:00 で日付が変わる", () => {
    // 2026-09-06 00:00:00 JST = 2026-09-05 15:00:00 UTC
    expect(dayKey(Date.UTC(2026, 8, 5, 15, 0, 0), JST)).toBe("2026-09-06");
  });

  it("タイムゾーンが違えば同じ瞬間でも日付が違う", () => {
    const at = Date.UTC(2026, 8, 5, 15, 0, 0);
    expect(dayKey(at, JST)).toBe("2026-09-06");
    expect(dayKey(at, "UTC")).toBe("2026-09-05");
  });
});

describe("weekdayOf", () => {
  it("2026-09-05 は土曜", () => {
    expect(weekdayOf("2026-09-05")).toBe(6);
  });

  it("2026-09-06 は日曜", () => {
    expect(weekdayOf("2026-09-06")).toBe(0);
  });
});

describe("dayOfMonthOf", () => {
  it("日を取り出す", () => {
    expect(dayOfMonthOf("2026-09-05")).toBe(5);
    expect(dayOfMonthOf("2026-09-30")).toBe(30);
  });
});

describe("localHour", () => {
  it("JST の朝8時を 8 として返す", () => {
    // 2026-09-06 08:00 JST = 2026-09-05 23:00 UTC
    expect(localHour(Date.UTC(2026, 8, 5, 23, 0, 0), JST)).toBe(8);
  });

  it("深夜0時は 24 ではなく 0", () => {
    expect(localHour(Date.UTC(2026, 8, 5, 15, 0, 0), JST)).toBe(0);
  });
});
