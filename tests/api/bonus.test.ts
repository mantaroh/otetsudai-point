import { beforeAll, describe, expect, it } from "vitest";
import { createHousehold, type Household } from "./client";
import type { BonusRule, BonusState } from "../../src/shared/types";

/**
 * ポイント2倍デーの API。
 * 倍率の計算そのものは単体テストで押さえてあるので、ここは DB 制約と権限を見る。
 */

let home: Household;

beforeAll(async () => {
  home = await createHousehold();
});

describe("今日を2倍にする", () => {
  it("最初は2倍になっていない", async () => {
    const result = await home.client.get("/api/bonus");
    expect(result.status).toBe(200);
    expect((result.body.state as BonusState).active).toBe(false);
    expect(result.body.rules).toEqual([]);
  });

  it("ONにすると2倍になり、理由が once になる", async () => {
    const result = await home.client.post("/api/bonus/today");
    expect(result.status).toBe(200);
    const state = result.body.state as BonusState;
    expect(state.active).toBe(true);
    expect(state.multiplier).toBe(2);
    expect(state.source).toBe("once");
  });

  it("二度押しても増えない", async () => {
    await home.client.post("/api/bonus/today");
    const result = await home.client.get("/api/bonus");
    expect((result.body.rules as BonusRule[]).filter((r) => r.kind === "once")).toHaveLength(1);
  });

  it("取り消すと戻る", async () => {
    const result = await home.client.del("/api/bonus/today");
    expect(result.status).toBe(200);
    expect((result.body.state as BonusState).active).toBe(false);
  });
});

describe("定期ルール", () => {
  it("毎週日曜を追加できる", async () => {
    const result = await home.client.post("/api/bonus/rules", { kind: "weekly", weekday: 0 });
    expect(result.status).toBe(201);
    expect((result.body.rule as BonusRule).weekday).toBe(0);
  });

  it("同じ曜日は二重に登録できない", async () => {
    const result = await home.client.post("/api/bonus/rules", { kind: "weekly", weekday: 0 });
    expect(result.status).toBe(409);
  });

  it("毎月9日を追加できる。曜日と同時に持てる", async () => {
    const result = await home.client.post("/api/bonus/rules", { kind: "monthly", dayOfMonth: 9 });
    expect(result.status).toBe(201);

    const listed = await home.client.get("/api/bonus");
    expect(listed.body.rules).toHaveLength(2);
  });

  it("範囲外の値は弾く", async () => {
    expect((await home.client.post("/api/bonus/rules", { kind: "weekly", weekday: 7 })).status)
      .toBe(400);
    expect((await home.client.post("/api/bonus/rules", { kind: "monthly", dayOfMonth: 32 })).status)
      .toBe(400);
  });

  it("削除できる", async () => {
    const listed = await home.client.get("/api/bonus");
    const rule = (listed.body.rules as BonusRule[])[0]!;
    expect((await home.client.del(`/api/bonus/rules/${rule.id}`)).status).toBe(200);

    const after = await home.client.get("/api/bonus");
    expect(after.body.rules).toHaveLength(1);
  });

  it("他の家庭のルールは消せない", async () => {
    const other = await createHousehold({ familyName: "よその家" });
    const created = await other.client.post("/api/bonus/rules", { kind: "weekly", weekday: 3 });
    const ruleId = (created.body.rule as BonusRule).id;

    expect((await home.client.del(`/api/bonus/rules/${ruleId}`)).status).toBe(404);
  });
});
