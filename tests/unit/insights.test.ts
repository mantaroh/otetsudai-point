import { describe, expect, it } from "vitest";
import { percentile, tzOffsetModifier } from "../../src/worker/db/uiEvents";

describe("percentile", () => {
  it("標本が無ければ null", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("並んでいなくても中央値を返す", () => {
    expect(percentile([50, 10, 30], 0.5)).toBe(30);
  });

  it("90 パーセンタイルは遅いほうを指す", () => {
    const values = Array.from({ length: 10 }, (_, index) => (index + 1) * 100);
    expect(percentile(values, 0.9)).toBe(1000);
    expect(percentile(values, 0.5)).toBe(600);
  });

  it("1件しか無ければその値", () => {
    expect(percentile([42], 0.9)).toBe(42);
  });
});

describe("tzOffsetModifier", () => {
  const summer = Date.UTC(2026, 6, 1);

  it("日本時間は +540 分", () => {
    expect(tzOffsetModifier("Asia/Tokyo", summer)).toBe("+540 minutes");
  });

  it("UTC は 0 分", () => {
    expect(tzOffsetModifier("UTC", summer)).toBe("+0 minutes");
  });

  it("30分刻みの地域も分で表せる", () => {
    expect(tzOffsetModifier("Asia/Kolkata", summer)).toBe("+330 minutes");
  });

  it("西側はマイナスになる", () => {
    expect(tzOffsetModifier("America/New_York", summer)).toBe("-240 minutes");
  });

  // 設定に壊れた値が入っていても、集計そのものは出したい
  it("知らないタイムゾーン名でも落ちない", () => {
    expect(tzOffsetModifier("Mars/Olympus", summer)).toBe("+0 minutes");
  });
});
