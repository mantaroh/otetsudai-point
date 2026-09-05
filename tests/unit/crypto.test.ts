import { describe, expect, it } from "vitest";
import {
  fromBase64Url,
  hashPin,
  hashToken,
  randomToken,
  signPayload,
  timingSafeEqual,
  toBase64Url,
  verifyPayload,
  verifyPin,
} from "../../src/worker/lib/crypto";

/**
 * Cookie の署名と PIN のハッシュ。
 * ここが破れると、他人の家庭に入れてしまう。
 */

describe("base64url", () => {
  it("往復して元に戻る", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it("URL に使えない文字を含まない", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("randomToken", () => {
  it("毎回ちがう値になる", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });
});

describe("hashToken", () => {
  it("同じトークンは同じハッシュ、ちがうトークンはちがうハッシュ", async () => {
    const token = randomToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
    expect(await hashToken(token)).not.toBe(await hashToken(randomToken()));
  });

  it("ハッシュから元のトークンは復元できない(長さが固定)", async () => {
    const short = await hashToken("a");
    const long = await hashToken("a".repeat(1000));
    expect(short.length).toBe(long.length);
  });
});

describe("timingSafeEqual", () => {
  it("一致・不一致を正しく判定する", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("署名つき Cookie", () => {
  const secret = "test-secret-that-is-long-enough-0123456789";

  it("自分で署名したものは検証できる", async () => {
    const signed = await signPayload(secret, { uid: "usr_1", exp: 999 });
    expect(await verifyPayload<{ uid: string }>(secret, signed)).toEqual({ uid: "usr_1", exp: 999 });
  });

  it("中身を書き換えると検証に落ちる", async () => {
    const signed = await signPayload(secret, { fid: "fam_own", exp: 999 });
    const [body, signature] = signed.split(".");

    // 別の家庭IDに差し替えた本体を、元の署名のまま送りつける
    const forgedBody = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ fid: "fam_someone_else", exp: 999 })),
    );
    expect(await verifyPayload(secret, `${forgedBody}.${signature}`)).toBeNull();
    expect(body).not.toBe(forgedBody);
  });

  it("署名を書き換えると検証に落ちる", async () => {
    const signed = await signPayload(secret, { uid: "usr_1", exp: 999 });
    const [body] = signed.split(".");
    expect(await verifyPayload(secret, `${body}.${toBase64Url(new Uint8Array(32))}`)).toBeNull();
  });

  it("別の鍵で署名されたものは受け付けない", async () => {
    const signed = await signPayload("another-secret-that-is-long-enough-0123", { uid: "usr_1", exp: 9 });
    expect(await verifyPayload(secret, signed)).toBeNull();
  });

  it("署名なしの生 JSON は受け付けない", async () => {
    const raw = toBase64Url(new TextEncoder().encode(JSON.stringify({ uid: "usr_1", exp: 999 })));
    expect(await verifyPayload(secret, raw)).toBeNull();
  });

  it("空・壊れた値でも例外を投げずに null を返す", async () => {
    expect(await verifyPayload(secret, undefined)).toBeNull();
    expect(await verifyPayload(secret, "")).toBeNull();
    expect(await verifyPayload(secret, "....")).toBeNull();
    expect(await verifyPayload(secret, "notbase64.notasignature")).toBeNull();
  });
});

describe("PIN", () => {
  const PEPPER = "server-side-pepper-that-is-long-enough-0123456789";

  it("正しい PIN だけが通る", async () => {
    const stored = await hashPin("1234", PEPPER);
    expect(await verifyPin("1234", stored, PEPPER)).toBe(true);
    expect(await verifyPin("1235", stored, PEPPER)).toBe(false);
    expect(await verifyPin("", stored, PEPPER)).toBe(false);
  });

  it("同じ PIN でも毎回ちがうハッシュになる(salt が効いている)", async () => {
    expect(await hashPin("1234", PEPPER)).not.toBe(await hashPin("1234", PEPPER));
  });

  it("保存形式に平文の PIN が現れない", async () => {
    const stored = await hashPin("1234", PEPPER);
    expect(stored).not.toContain("1234");
    expect(stored.startsWith("pbkdf2p$")).toBe(true);
  });

  /**
   * ペッパーがこの方式の要。
   * D1 の中身だけが漏れても、鍵が無ければ PIN の候補を試せない。
   */
  it("ペッパーが違えば、正しい PIN でも通らない", async () => {
    const stored = await hashPin("1234", PEPPER);
    expect(await verifyPin("1234", stored, "another-pepper-0123456789012345678")).toBe(false);
    expect(await verifyPin("1234", stored, "")).toBe(false);
  });

  it("壊れた保存値で例外を投げずに false を返す", async () => {
    expect(await verifyPin("1234", "", PEPPER)).toBe(false);
    expect(await verifyPin("1234", "plaintext", PEPPER)).toBe(false);
    expect(await verifyPin("1234", "md5$1$a$b", PEPPER)).toBe(false);
    expect(await verifyPin("1234", "pbkdf2p$abc$a$b", PEPPER)).toBe(false);
  });

  /** 反復回数は保存値から読むので、細工されて CPU を焼かれないようにする */
  it("常識外れの反復回数が入っていたら、計算せずに落とす", async () => {
    expect(await verifyPin("1234", "pbkdf2p$99999999$a$b", PEPPER)).toBe(false);
    expect(await verifyPin("1234", "pbkdf2p$0$a$b", PEPPER)).toBe(false);
    expect(await verifyPin("1234", "pbkdf2p$-1$a$b", PEPPER)).toBe(false);
  });

  /**
   * Workers の CPU 時間は1リクエスト 10ms(無料プラン)。
   * ここが重いと、家庭の作成も PIN の検証もランタイムに落とされる。
   * 実際に 21万回の PBKDF2 で本番が 500 になった。
   */
  /**
   * Workers には1リクエストあたりの CPU 時間の上限がある(無料プランで 10ms)。
   * ここを重くすると、家庭の作成も PIN の検証もランタイムに落とされて 500 になる。
   * 実際に 21万回で本番が落ちた。
   *
   * Workers ランタイムでの実測:
   *   21万回 = 112ms / 5万回 = 26ms / 2.5万回 = 14ms / 1万回 = 8ms
   *   いまの設定(2千回 + ペッパー)= hashPin 1.9ms / verifyPin 1.5ms
   *
   * 実時間で測ると、動いている他の処理に引きずられて不安定になるので、
   * 保存形式に書かれた反復回数のほうを見る。
   */
  it("反復回数が CPU 時間に見合う範囲にある", async () => {
    const rounds = Number((await hashPin("1234", PEPPER)).split("$")[1]);
    expect(rounds).toBeGreaterThanOrEqual(1_000);
    expect(rounds).toBeLessThanOrEqual(5_000);
  });
});
