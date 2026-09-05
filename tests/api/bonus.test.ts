import { beforeAll, describe, expect, it } from "vitest";
import { Client, claimPath, createHousehold, currentSheet, stick, uuid, type Household } from "./client";
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

describe("2倍デーのシール発行", () => {
  it("2倍の日は押した回数の2倍が貼られる", async () => {
    const family = await createHousehold({ capacity: 30 });
    const child = family.children[0]!;

    await family.client.post("/api/bonus/today");
    const result = await stick(family.client, child.id, family.choreId, 3);

    expect(result.status).toBe(201);
    expect(result.body.grant.count).toBe(6);
    expect(result.body.grant.baseCount).toBe(3);
    expect(result.body.grant.multiplier).toBe(2);
    expect((await currentSheet(family.client, child.id)).filled).toBe(6);
  });

  it("取り消したあとは1倍に戻る", async () => {
    const family = await createHousehold({ capacity: 30 });
    const child = family.children[0]!;

    await family.client.post("/api/bonus/today");
    await family.client.del("/api/bonus/today");
    const result = await stick(family.client, child.id, family.choreId, 3);

    expect(result.body.grant.count).toBe(3);
    expect(result.body.grant.multiplier).toBe(1);
  });

  it("倍後に台帳をまたいでも正しく配られる", async () => {
    // 5マスの台帳に 2 枚貼ってある状態で、2倍で 6 枚追加する
    const family = await createHousehold({ capacity: 5 });
    const child = family.children[0]!;
    await stick(family.client, child.id, family.choreId, 2);

    await family.client.post("/api/bonus/today");
    const result = await stick(family.client, child.id, family.choreId, 3);

    expect(result.status).toBe(201);
    expect(result.body.grant.count).toBe(6);
    // 1冊目が満了し、2冊目に 3 枚残る
    expect((await currentSheet(family.client, child.id)).seqNo).toBe(2);
    expect((await currentSheet(family.client, child.id)).filled).toBe(3);
  });

  it("bootstrap が今日の状態を返す", async () => {
    const family = await createHousehold();
    expect((await family.client.get("/api/bootstrap")).body.bonusToday.active).toBe(false);

    await family.client.post("/api/bonus/today");
    const boot = await family.client.get("/api/bootstrap");
    expect(boot.body.bonusToday.active).toBe(true);
    expect(boot.body.bonusToday.multiplier).toBe(2);
  });
});

/**
 * 倍率は「申告した瞬間」に決まり、「承認した瞬間」には決め直さない。
 *
 * 承認あり運用では親の承認が翌日にずれることがある。倍率を承認時に決める実装だと
 * 「2倍のつもりで押したのに、承認されたら1倍だった(またはその逆)」が起きる。
 * 申告時点の倍率が承認まで変わらず生き残ることを固定しておく。
 */
describe("倍率は承認時ではなく申告時に決まる(承認あり運用)", () => {
  it("子の申請は申告時点の倍率のまま承認され、承認時に掛け直されない", async () => {
    const home = await createHousehold({ capacity: 30 });
    expect((await home.client.patch("/api/settings", { requireApproval: true })).status).toBe(200);
    await home.client.post("/api/bonus/today");

    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "リビングのタブレット",
    });
    const tablet = new Client();
    await tablet.post(claimPath(invite.body.url));

    const child = home.children[0]!;
    const requested = await stick(tablet, child.id, home.choreId, 2);

    expect(requested.status).toBe(201);
    expect(requested.body.grant.createdVia).toBe("self");
    expect(requested.body.grant.approvedAt).toBeNull();
    expect(requested.body.grant.baseCount).toBe(2);
    expect(requested.body.grant.multiplier).toBe(2);
    // 倍率は申告した時点で確定している(承認前でもすでに4)
    expect(requested.body.grant.count).toBe(4);

    // 承認前なので、台帳にはまだ何も貼られていない
    expect((await currentSheet(home.client, child.id)).filled).toBe(0);

    const boot = (await home.client.get("/api/bootstrap")).body;
    const pending = boot.pendingGrants.find((g: any) => g.id === requested.body.grant.id);
    expect(pending).toBeTruthy();
    expect(pending.baseCount).toBe(2);
    expect(pending.multiplier).toBe(2);
    expect(pending.count).toBe(4);

    const approved = await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);
    expect(approved.status).toBe(200);
    // 承認では倍率を掛け直さない: 2 でも 8 でもなく、申告時に決めた 4 のまま
    expect(approved.body.grant.count).toBe(4);
    expect(approved.body.grant.multiplier).toBe(2);
    expect((await currentSheet(home.client, child.id)).filled).toBe(4);
  });
});

/**
 * POST /api/grants は requestId で重複排除する。
 *
 * 通信の再送や連打の取りこぼしで同じリクエストがもう一度届いても、
 * 2倍デーの倍率がもう一度掛かって二重に貼られてはならない。
 */
describe("2倍デーの再送は倍率を再適用しない", () => {
  it("同じ requestId で同じ申請を再送しても、貼られるシールは1回ぶんのまま", async () => {
    const family = await createHousehold({ capacity: 30 });
    const child = family.children[0]!;
    await family.client.post("/api/bonus/today");

    const requestId = uuid();
    const body = { memberId: child.id, choreId: family.choreId, count: 3, requestId };

    const first = await family.client.post("/api/grants", body);
    expect(first.status).toBe(201);
    expect(first.body.grant.baseCount).toBe(3);
    expect(first.body.grant.multiplier).toBe(2);
    expect(first.body.grant.count).toBe(6);

    const second = await family.client.post("/api/grants", body);
    expect(second.status).toBe(201);
    expect(second.body.grant.id).toBe(first.body.grant.id);
    expect(second.body.grant.count).toBe(6);
    expect(second.body.grant.multiplier).toBe(2);

    // 倍率が二重に掛かれば 12 になってしまうところ、6 のまま
    expect((await currentSheet(family.client, child.id)).filled).toBe(6);
  });
});

describe("通知の二重送信", () => {
  it("最初のONで送る担当になる", async () => {
    const family = await createHousehold();
    const result = await family.client.post("/api/bonus/today");
    expect(result.body.notified).toBe(true);
  });

  it("同じ日に二度目のONでは送らない", async () => {
    const family = await createHousehold();
    await family.client.post("/api/bonus/today");
    const second = await family.client.post("/api/bonus/today");
    expect(second.body.notified).toBe(false);
  });

  it("取り消してからONし直しても、その日はもう送らない", async () => {
    const family = await createHousehold();
    await family.client.post("/api/bonus/today");
    await family.client.del("/api/bonus/today");
    const again = await family.client.post("/api/bonus/today");
    expect(again.body.notified).toBe(false);
  });
});
