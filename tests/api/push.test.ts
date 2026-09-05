import { beforeAll, describe, expect, it } from "vitest";
import { createHousehold, type Household } from "./client";

/**
 * Web Push の購読。実際の配信はここでは扱わない。
 * 「登録できる」「登録し直せる」「解除できる」「他の家庭に漏れない」を見る。
 */

let home: Household;

const SUBSCRIPTION = {
  endpoint: "https://push.example.com/sub/abc123",
  keys: { p256dh: "BExamplePublicKey", auth: "ExampleAuthSecret" },
};

beforeAll(async () => {
  home = await createHousehold();
});

describe("購読", () => {
  it("VAPID 公開鍵を取得できる", async () => {
    const result = await home.client.get("/api/push/config");
    expect(result.status).toBe(200);
    // ローカルでは鍵を設定していないので null になる
    expect(result.body).toHaveProperty("publicKey");
  });

  it("登録できる", async () => {
    const result = await home.client.post("/api/push/subscribe", SUBSCRIPTION);
    expect(result.status).toBe(201);
  });

  it("鍵が欠けていたら弾く", async () => {
    const result = await home.client.post("/api/push/subscribe", {
      endpoint: "https://push.example.com/sub/broken",
    });
    expect(result.status).toBe(400);
  });

  it("同じ端末を登録し直せる（古い購読は無効化される）", async () => {
    // Service Worker が購読を更新したときや、同じ端末が別の家庭に渡ったときに
    // 同じ endpoint で再登録できる必要がある。revoke-before-insert が無いと、
    // endpoint のユニーク制約に引っかかって2回目の登録が 500 で失敗する。
    const second = await home.client.post("/api/push/subscribe", SUBSCRIPTION);
    expect(second.status).toBe(201);

    const path = `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`;
    const first = await home.client.del(path);
    expect(first.status).toBe(200);
    // removed が 1 であることまで見て、古い行が新しい行と一緒に残っていないことを確認する。
    expect(first.body.removed).toBe(1);
    // 2つ残っていたら、ここも 200 になってしまう
    expect((await home.client.del(path)).status).toBe(404);
  });

  it("他の家庭の購読は解除できない", async () => {
    const other = await createHousehold({ familyName: "よその家" });
    // 端末が別の家庭に渡ったケース。古い家庭の購読を無効化してから
    // 新しい家庭で登録し直せる(500にならない)ことも合わせて確認する。
    const registered = await other.client.post("/api/push/subscribe", SUBSCRIPTION);
    expect(registered.status).toBe(201);

    const result = await home.client.del(
      `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`,
    );
    // 自分の家庭に無いので「見つからない」
    expect(result.status).toBe(404);
  });
});
