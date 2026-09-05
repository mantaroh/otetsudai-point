import { describe, expect, it } from "vitest";
import { normalizeChoreName } from "../../src/worker/db/family";
import { matchPath } from "../../src/client/router";

/**
 * お手伝いメニューは自由入力で自己増殖するので、
 * 表記ゆれの吸収が甘いと「食器あらい」が3件並ぶことになる。
 */
describe("normalizeChoreName", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeChoreName("  おふろそうじ  ")).toBe("おふろそうじ");
  });

  it("連続した空白を1つにまとめる", () => {
    expect(normalizeChoreName("ねこの   トイレそうじ")).toBe("ねこの トイレそうじ");
  });

  it("全角空白も同じ扱いにする", () => {
    expect(normalizeChoreName("ねこの　トイレそうじ")).toBe(normalizeChoreName("ねこの トイレそうじ"));
  });

  it("全角の英数字を半角に寄せる", () => {
    expect(normalizeChoreName("ＤＶＤかたづけ")).toBe(normalizeChoreName("DVDかたづけ"));
  });

  it("半角カナを全角に寄せる", () => {
    expect(normalizeChoreName("ｺﾞﾐすて")).toBe(normalizeChoreName("ゴミすて"));
  });

  it("大文字小文字の違いを吸収する", () => {
    expect(normalizeChoreName("DVDかたづけ")).toBe(normalizeChoreName("dvdかたづけ"));
  });

  it("ちがうお手伝いは別物のまま", () => {
    expect(normalizeChoreName("おふろそうじ")).not.toBe(normalizeChoreName("トイレそうじ"));
  });
});

describe("matchPath", () => {
  it("固定のパスに一致する", () => {
    expect(matchPath("/parent", "/parent")).toEqual({});
  });

  it("パラメータを取り出す", () => {
    expect(matchPath("/m/:memberId", "/m/mem_123")).toEqual({ memberId: "mem_123" });
    expect(matchPath("/m/:memberId/shelf", "/m/mem_123/shelf")).toEqual({ memberId: "mem_123" });
  });

  it("長さが違えば一致しない", () => {
    expect(matchPath("/m/:memberId", "/m/mem_123/shelf")).toBeNull();
    expect(matchPath("/m/:memberId/shelf", "/m/mem_123")).toBeNull();
  });

  it("固定部分が違えば一致しない", () => {
    expect(matchPath("/m/:memberId/shelf", "/m/mem_123/history")).toBeNull();
  });

  it("URL エンコードされた値を戻す", () => {
    expect(matchPath("/m/:memberId", "/m/%E3%81%AF%E3%81%AA")).toEqual({ memberId: "はな" });
  });
});
