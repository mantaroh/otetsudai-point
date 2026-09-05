import { describe, expect, it } from "vitest";
import { withExternalBrowser } from "../../src/client/lib/inviteUrl";

/**
 * LINE でリンクをタップすると、既定ではアプリ内ブラウザで開く。
 * そこで端末を登録しても Cookie はアプリ内ブラウザにしか残らず、
 * あとで Safari や Chrome から開くと未登録のままになる。
 * openExternalBrowser=1 を付けると、LINE が既定のブラウザで開いてくれる。
 */
describe("withExternalBrowser", () => {
  const base = "https://otetsudai.example.com/invite/abc123";

  it("有効にすると印が付く", () => {
    expect(withExternalBrowser(base, true)).toBe(`${base}?openExternalBrowser=1`);
  });

  it("無効にすると付かない", () => {
    expect(withExternalBrowser(base, false)).toBe(base);
  });

  it("何度かけても増えない", () => {
    const once = withExternalBrowser(base, true);
    expect(withExternalBrowser(once, true)).toBe(once);
    expect(withExternalBrowser(withExternalBrowser(once, true), true)).toBe(once);
  });

  it("有効にしたあと無効に戻せる", () => {
    expect(withExternalBrowser(withExternalBrowser(base, true), false)).toBe(base);
  });

  it("トークンを含むパスは変えない", () => {
    expect(new URL(withExternalBrowser(base, true)).pathname).toBe("/invite/abc123");
  });

  it("もとから付いている他のパラメータを消さない", () => {
    const withOther = `${base}?ref=line`;
    const result = new URL(withExternalBrowser(withOther, true));
    expect(result.searchParams.get("ref")).toBe("line");
    expect(result.searchParams.get("openExternalBrowser")).toBe("1");
  });

  it("URL として壊れていても、画面を落とさずそのまま返す", () => {
    expect(withExternalBrowser("これはURLではない", true)).toBe("これはURLではない");
  });
});
