import { beforeAll, describe, expect, it } from "vitest";
import { createHousehold, type Household } from "./client";

/**
 * Web Push の購読。実際の配信はここでは扱わない。
 * 「登録できる」「解除できる」「他の家庭に漏れない」を見る。
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

  it("二度登録しても有効な購読は1つだけ", async () => {
    // 同じ endpoint で登録し直す。古い行は無効化され、有効なものは常に1つ。
    await home.client.post("/api/push/subscribe", SUBSCRIPTION);

    const path = `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`;
    expect((await home.client.del(path)).status).toBe(200);
    // 2つ残っていたら、ここも 200 になってしまう
    expect((await home.client.del(path)).status).toBe(404);
  });

  it("他の家庭の購読は解除できない", async () => {
    const other = await createHousehold({ familyName: "よその家" });
    await other.client.post("/api/push/subscribe", SUBSCRIPTION);

    const result = await home.client.del(
      `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`,
    );
    // 自分の家庭に無いので「見つからない」
    expect(result.status).toBe(404);
  });
});
