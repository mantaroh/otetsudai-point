import { describe, expect, it } from "vitest";
import { Client, claimPath, createHousehold, type Household } from "./client";
import type { Chore } from "../../src/shared/types";

/**
 * お手伝いメニューの並び順。
 *
 * 並びは親が決める。子どもから見て、毎回同じ位置に同じボタンがあることが大事なので、
 * 「勝手に動かない」ことと「新しく足したものは一番上」を中心に押さえる。
 */

async function names(home: Household): Promise<string[]> {
  const listed = await home.client.get("/api/chores");
  return (listed.body as Chore[]).map((chore) => chore.name);
}

async function ids(home: Household): Promise<string[]> {
  const listed = await home.client.get("/api/chores");
  return (listed.body as Chore[]).map((chore) => chore.id);
}

describe("並べ替え", () => {
  it("送った順に並ぶ", async () => {
    const home = await createHousehold();
    const reversed = (await ids(home)).reverse();

    const result = await home.client.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: reversed },
    });

    expect(result.status).toBe(200);
    expect(await ids(home)).toEqual(reversed);
  });

  it("子の台帳(bootstrap)も同じ順になる", async () => {
    const home = await createHousehold();
    const reversed = (await ids(home)).reverse();
    await home.client.request("/api/chores/order", { method: "PUT", body: { choreIds: reversed } });

    const boot = await home.client.get("/api/bootstrap");
    expect((boot.body.chores as Chore[]).map((chore) => chore.id)).toEqual(reversed);
  });

  it("並べ替えのあとも、シールを貼っただけでは順が動かない", async () => {
    // これまでは使用頻度順だったので、よく押すものほど上がっていった
    const home = await createHousehold();
    const order = await ids(home);
    const last = order[order.length - 1]!;

    for (let i = 0; i < 3; i++) {
      await home.client.post("/api/grants", {
        memberId: home.children[0]!.id,
        choreId: last,
        count: 1,
        requestId: crypto.randomUUID(),
      });
    }

    expect(await ids(home)).toEqual(order);
  });
});

/**
 * 画面が古い一覧のまま並べ替えを送ってきた場合。
 * 親が並べ替えている間に、子が「そのほか」で1件足した、が一番ありそうなケース。
 * そのまま振り直すと、足された1件だけ番号が付かずに残るので、断って読み込み直させる。
 */
describe("古い並びは断る", () => {
  it("1件足りなければ 409", async () => {
    const home = await createHousehold();
    const order = await ids(home);

    const result = await home.client.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: order.slice(1) },
    });

    expect(result.status).toBe(409);
    // 断ったときは何も変えない
    expect(await ids(home)).toEqual(order);
  });

  it("同じ ID が2回入っていても 409", async () => {
    const home = await createHousehold();
    const order = await ids(home);

    const result = await home.client.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: [order[0], ...order.slice(0, -1)] },
    });

    expect(result.status).toBe(409);
  });

  it("他の家庭のお手伝いが混ざっていたら 409", async () => {
    const home = await createHousehold();
    const other = await createHousehold({ familyName: "よその家" });
    const order = await ids(home);
    const foreign = (await ids(other))[0]!;

    const result = await home.client.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: [...order.slice(1), foreign] },
    });

    expect(result.status).toBe(409);
    // よその家の並びにも触れていない
    expect((await ids(other))[0]).toBe(foreign);
  });

  it("アーカイブ済みは並びに含めなくてよい", async () => {
    const home = await createHousehold();
    const order = await ids(home);
    await home.client.patch(`/api/chores/${order[0]}`, { archived: true });

    const result = await home.client.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: order.slice(1).reverse() },
    });

    expect(result.status).toBe(200);
  });
});

describe("新しく足したものは一番上", () => {
  it("親設定から足すと一番上に出る", async () => {
    const home = await createHousehold();

    await home.client.post("/api/chores", { name: "まどふき", emoji: "🪟" });

    expect((await names(home))[0]).toBe("まどふき");
  });

  it("並べ替えたあとに足しても一番上に出て、他の順は崩れない", async () => {
    const home = await createHousehold();
    const reversed = (await ids(home)).reverse();
    await home.client.request("/api/chores/order", { method: "PUT", body: { choreIds: reversed } });

    const added = await home.client.post("/api/chores", { name: "まどふき" });

    expect(await ids(home)).toEqual([added.body.id, ...reversed]);
  });

  it("子が台帳の「そのほか」で足しても一番上に出る", async () => {
    const home = await createHousehold();
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "リビングのタブレット",
    });
    const tablet = new Client();
    await tablet.post(claimPath(invite.body.url));

    await tablet.post("/api/grants", {
      memberId: home.children[0]!.id,
      choreName: "くつならべ",
      count: 1,
      requestId: crypto.randomUUID(),
    });

    expect((await names(home))[0]).toBe("くつならべ");
  });

  it("すでにある名前を打っても、その場所から動かない", async () => {
    // 子が既存のお手伝いの名前を「そのほか」に打っただけ、という場合
    const home = await createHousehold();
    const before = await names(home);
    const middle = before[Math.floor(before.length / 2)]!;

    await home.client.post("/api/chores", { name: middle });

    expect(await names(home)).toEqual(before);
  });

  it("アーカイブしたものを同じ名前で足し直すと、一番上に戻る", async () => {
    const home = await createHousehold();
    const before = await names(home);
    const last = before[before.length - 1]!;
    const lastId = (await ids(home))[before.length - 1]!;
    await home.client.patch(`/api/chores/${lastId}`, { archived: true });

    await home.client.post("/api/chores", { name: last });

    expect((await names(home))[0]).toBe(last);
  });

  it("名前やめやす枚数を直しても、その場所から動かない", async () => {
    // 戻す操作と同じ PATCH を通るので、アーカイブされていないものは動かさないことを固定する
    const home = await createHousehold();
    const order = await ids(home);
    const middle = order[Math.floor(order.length / 2)]!;

    await home.client.patch(`/api/chores/${middle}`, {
      name: "なまえをかえた",
      defaultCount: 3,
      archived: false,
    });

    expect(await ids(home)).toEqual(order);
  });

  it("親設定でアーカイブを戻しても、一番上に戻る", async () => {
    const home = await createHousehold();
    const order = await ids(home);
    const lastId = order[order.length - 1]!;
    await home.client.patch(`/api/chores/${lastId}`, { archived: true });

    await home.client.patch(`/api/chores/${lastId}`, { archived: false });

    expect((await ids(home))[0]).toBe(lastId);
  });
});

describe("並べ替えは親だけ", () => {
  it("子の端末からは並べ替えできない", async () => {
    const home = await createHousehold();
    const order = await ids(home);
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "リビングのタブレット",
    });
    const tablet = new Client();
    await tablet.post(claimPath(invite.body.url));

    const result = await tablet.request("/api/chores/order", {
      method: "PUT",
      body: { choreIds: [...order].reverse() },
    });

    // PIN を求められる(親操作の入口)。並びは変わっていない
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("pin_required");
    expect(await ids(home)).toEqual(order);
  });
});
