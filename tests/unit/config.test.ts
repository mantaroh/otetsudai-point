import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appOrigin, isDevelopment } from "../../src/worker/lib/origin";
import type { AppContext, AppEnv } from "../../src/worker/types";

/**
 * デプロイ時にいちばん危ないのは、設定の書き忘れではなく「書き足してしまう」ほう。
 * 開発用の入口が本番に乗ると、誰でもログインできる状態になる。
 */

function fakeContext(env: Partial<AppEnv>, url = "https://example.com/api/x"): AppContext {
  return { env, req: { url } } as unknown as AppContext;
}

describe("開発用サインインの可否", () => {
  it("明示的に development のときだけ有効になる", () => {
    expect(isDevelopment(fakeContext({ ENVIRONMENT: "development" }))).toBe(true);
  });

  it("未設定なら本番扱い(書き忘れても安全側に倒れる)", () => {
    expect(isDevelopment(fakeContext({}))).toBe(false);
  });

  it("それ以外の値も本番扱い", () => {
    for (const value of ["production", "prod", "staging", "Development", "", " development "]) {
      expect(isDevelopment(fakeContext({ ENVIRONMENT: value }))).toBe(false);
    }
  });
});

describe("公開 URL の判定", () => {
  it("設定が無ければリクエストの origin を使う", () => {
    expect(appOrigin(fakeContext({}, "https://otetsudai.example.com/auth/google"))).toBe(
      "https://otetsudai.example.com",
    );
    expect(appOrigin(fakeContext({}, "http://localhost:5173/api/bootstrap"))).toBe(
      "http://localhost:5173",
    );
  });

  it("設定があればそちらを優先する", () => {
    expect(appOrigin(fakeContext({ APP_ORIGIN: "https://a.example.com" }))).toBe(
      "https://a.example.com",
    );
  });

  it("末尾のスラッシュは落とす(リンクが // にならないように)", () => {
    expect(appOrigin(fakeContext({ APP_ORIGIN: "https://a.example.com/" }))).toBe(
      "https://a.example.com",
    );
  });

  it("空文字や空白だけの設定は無視する", () => {
    expect(appOrigin(fakeContext({ APP_ORIGIN: "  " }, "https://b.example.com/x"))).toBe(
      "https://b.example.com",
    );
  });
});

describe("wrangler.jsonc", () => {
  const source = readFileSync("wrangler.jsonc", "utf8");
  // 行コメントを落としてから中身を見る(注意書きの中の単語に反応しないように)
  const withoutComments = source.replace(/^\s*\/\/.*$/gm, "");

  /**
   * ここに ENVIRONMENT を書くと、そのままデプロイ先に乗る。
   * ローカルの値は .dev.vars に置く、という約束を壊さないための番人。
   */
  it("ENVIRONMENT を持たない(デプロイに乗ってしまうため)", () => {
    expect(withoutComments).not.toMatch(/"ENVIRONMENT"/);
  });

  it("シークレットが直接書かれていない", () => {
    expect(withoutComments).not.toMatch(/"SESSION_SECRET"/);
    expect(withoutComments).not.toMatch(/"GOOGLE_CLIENT_SECRET"/);
  });

  it("API と認証は静的ファイルより先に Worker へ回す", () => {
    // ここが抜けると /api/* が SPA フォールバックに食われて index.html が返る
    expect(withoutComments).toMatch(/run_worker_first/);
    for (const path of ["/api/*", "/auth/*"]) {
      expect(withoutComments).toContain(path);
    }
  });

  /**
   * 招待リンクを開いたときは、画面を出すだけにする。
   * Worker に先回りさせて GET で処理すると、LINE のリンクプレビューのような
   * 「開くだけ」の相手にトークンを使い切られる。
   */
  it("招待リンクは Worker 先回りにしない(プレビューに消費されるため)", () => {
    expect(withoutComments).not.toContain("/invite/*");
  });

  it("SPA フォールバックが有効になっている", () => {
    expect(withoutComments).toMatch(/"not_found_handling":\s*"single-page-application"/);
  });
});

describe(".dev.vars.example", () => {
  const source = readFileSync(".dev.vars.example", "utf8");

  it("本番で設定してはいけないことが書いてある", () => {
    expect(source).toMatch(/ENVIRONMENT=development/);
    expect(source).toMatch(/本番では絶対に設定しない/);
  });

  it("実際の値は入っていない", () => {
    expect(source).toMatch(/^SESSION_SECRET=$/m);
  });
});
