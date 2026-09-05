import { beforeAll, describe, expect, it } from "vitest";
import {
  Client,
  createHousehold,
  currentSheet,
  stick,
  uuid,
  type Household,
} from "./client";

/**
 * 台帳まわりの結合テスト。実際の Worker と D1 に対して叩く。
 * 単体テストで allocate() の計算は押さえてあるので、ここは DB 制約と組み合わせた挙動を見る。
 */

let home: Household;
let hana: { id: string; name: string };
let taro: { id: string; name: string };

beforeAll(async () => {
  home = await createHousehold({ capacity: 5 });
  hana = home.children[0]!;
  taro = home.children[1]!;
});

describe("家庭の初期状態", () => {
  it("子ごとに台帳が発行されている", async () => {
    expect(Object.keys(home.boot.sheets)).toHaveLength(2);
    expect(home.boot.sheets[hana.id]!.seqNo).toBe(1);
    expect(home.boot.sheets[hana.id]!.filled).toBe(0);
  });

  it("お手伝いメニューの種が入っている", () => {
    expect(home.boot.chores.length).toBeGreaterThanOrEqual(5);
  });

  it("うちの運用が既定になっている(承認なし・自己申告あり)", () => {
    expect(home.boot.settings.requireApproval).toBe(false);
    expect(home.boot.settings.allowSelfGrant).toBe(true);
    expect(home.boot.settings.capacity).toBe(5);
  });

  it("日本語の名前がそのまま保存される", () => {
    expect(home.children.map((child) => child.name)).toEqual(["はな", "たろう"]);
  });
});

describe("シールを貼る", () => {
  it("1枚貼れて、絵柄はお手伝いの絵文字になる", async () => {
    const result = await stick(home.client, hana.id, home.choreId);
    expect(result.status).toBe(201);
    expect(result.body.sheets[0].filled).toBe(1);
    expect(result.body.sheets[0].stickers[0].art).toBe(home.boot.chores[0]!.emoji);
  });

  it("承認なしの家庭では、貼った瞬間に有効になる", async () => {
    const result = await stick(home.client, taro.id, home.choreId);
    expect(result.body.grant.approvedAt).not.toBeNull();
  });

  it("枚数の上限を超える指定は弾かれる", async () => {
    const result = await home.client.post("/api/grants", {
      memberId: hana.id,
      choreId: home.choreId,
      count: 999,
      requestId: uuid(),
    });
    expect(result.status).toBe(400);
  });

  it("お手伝いを指定しないと弾かれる", async () => {
    const result = await home.client.post("/api/grants", {
      memberId: hana.id,
      count: 1,
      requestId: uuid(),
    });
    expect(result.status).toBe(400);
  });

  it("親の台帳にはシールを貼れない", async () => {
    const parent = home.boot.members.find((member) => member.role === "parent")!;
    const result = await stick(home.client, parent.id, home.choreId);
    expect(result.status).toBe(400);
  });
});

describe("連打による二重送信", () => {
  it("同じ requestId は1件にまとめられる", async () => {
    const home2 = await createHousehold({ capacity: 30 });
    const child = home2.children[0]!;
    const requestId = uuid();

    const [first, second] = await Promise.all([
      home2.client.post("/api/grants", {
        memberId: child.id,
        choreId: home2.choreId,
        count: 1,
        requestId,
      }),
      home2.client.post("/api/grants", {
        memberId: child.id,
        choreId: home2.choreId,
        count: 1,
        requestId,
      }),
    ]);

    expect(first.body.grant.id).toBe(second.body.grant.id);
    expect((await currentSheet(home2.client, child.id)).filled).toBe(1);
  });
});

describe("台帳またぎ", () => {
  it("あふれた分が次の台帳に繰り越される", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 3);
    const result = await stick(home2.client, child.id, home2.choreId, 3);

    expect(result.body.becameFull).toBe(true);
    expect(result.body.sheets).toHaveLength(2);

    const [first, second] = result.body.sheets;
    expect(first.filled).toBe(5);
    expect(first.status).toBe("full");
    expect(second.filled).toBe(1);
    expect(second.status).toBe("active");
    expect(second.seqNo).toBe(first.seqNo + 1);
  });

  it("2冊以上またいでも通し番号が連続する", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const result = await stick(home2.client, child.id, home2.choreId, 12);
    expect(result.body.sheets.map((sheet: any) => sheet.seqNo)).toEqual([1, 2, 3]);
    expect(result.body.sheets.map((sheet: any) => sheet.filled)).toEqual([5, 5, 2]);
    expect((await currentSheet(home2.client, child.id)).seqNo).toBe(3);
  });
});

describe("取り消し", () => {
  it("シールが無効になり、マスに穴が空く", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const grant = await stick(home2.client, child.id, home2.choreId, 2);
    await stick(home2.client, child.id, home2.choreId, 1);

    const revoked = await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.grant.revokedAt).not.toBeNull();
    expect((await currentSheet(home2.client, child.id)).filled).toBe(1);
  });

  it("取り消した記録は履歴に残る", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const grant = await stick(home2.client, child.id, home2.choreId, 1);
    await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, { reason: "まちがい" });

    const history = await home2.client.get(`/api/members/${child.id}/history`);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].revokedAt).not.toBeNull();
    expect(history.body[0].revokeReason).toBe("まちがい");
  });

  it("空いた穴を、次のシールが埋める", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 1); // 1マス目
    const second = await stick(home2.client, child.id, home2.choreId, 1); // 2マス目
    await stick(home2.client, child.id, home2.choreId, 1); // 3マス目

    await home2.client.post(`/api/grants/${second.body.grant.id}/revoke`, {});
    const refilled = await stick(home2.client, child.id, home2.choreId, 1);

    const positions = refilled.body.sheets[0].stickers.map((sticker: any) => sticker.position);
    expect(positions).toEqual([1, 2, 3]);
  });

  it("満了していた台帳は、穴が空けば active に戻る", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const grant = await stick(home2.client, child.id, home2.choreId, 5);
    expect(grant.body.becameFull).toBe(true);

    await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {});
    const sheet = await currentSheet(home2.client, child.id);
    expect(sheet.status).toBe("active");
    expect(sheet.filled).toBe(0);
  });

  it("繰り越し済みの場合、古い台帳は full のままにする", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const first = await stick(home2.client, child.id, home2.choreId, 1);
    await stick(home2.client, child.id, home2.choreId, 6); // 5枚で満了 + 2冊目へ2枚

    await home2.client.post(`/api/grants/${first.body.grant.id}/revoke`, {});

    // active なのはあくまで最新の台帳。古い台帳を勝手に開け直したりしない
    const sheet = await currentSheet(home2.client, child.id);
    expect(sheet.seqNo).toBe(2);
    expect(sheet.status).toBe("active");
  });

  it("同じ付与を2回取り消しても壊れない", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    const grant = await stick(home2.client, child.id, home2.choreId, 2);
    await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {});
    const again = await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {});

    expect(again.status).toBe(200);
    expect((await currentSheet(home2.client, child.id)).filled).toBe(0);
  });
});

describe("お手伝いメニューの自己増殖", () => {
  it("自由入力したお手伝いがメニューに載る", async () => {
    const home2 = await createHousehold({ capacity: 30 });
    await home2.client.post("/api/grants", {
      memberId: home2.children[0]!.id,
      choreName: "  ねこの トイレそうじ  ",
      count: 1,
      requestId: uuid(),
    });

    const chores = await home2.client.get("/api/chores");
    const added = chores.body.filter((chore: any) => chore.name === "ねこの トイレそうじ");
    expect(added).toHaveLength(1);
  });

  it("表記ゆれは既存メニューにマージされる", async () => {
    const home2 = await createHousehold({ capacity: 30 });
    const [first, second] = home2.children;

    await home2.client.post("/api/grants", {
      memberId: first!.id,
      choreName: "DVDかたづけ",
      count: 1,
      requestId: uuid(),
    });
    await home2.client.post("/api/grants", {
      memberId: second!.id,
      choreName: "ＤＶＤかたづけ",
      count: 1,
      requestId: uuid(),
    });

    const chores = await home2.client.get("/api/chores");
    const matched = chores.body.filter((chore: any) => /DVD/i.test(chore.name));
    expect(matched).toHaveLength(1);
    expect(matched[0].useCount).toBe(2);
  });

  it("兄弟どちらの選択肢にも同じメニューが出る", async () => {
    const home2 = await createHousehold({ capacity: 30 });
    await home2.client.post("/api/grants", {
      memberId: home2.children[0]!.id,
      choreName: "きんぎょのえさやり",
      count: 1,
      requestId: uuid(),
    });

    // メニューは家族共通なので、もう一方の子からも同じ chore_id で貼れる
    const chores = await home2.client.get("/api/chores");
    const chore = chores.body.find((item: any) => item.name === "きんぎょのえさやり");
    const result = await stick(home2.client, home2.children[1]!.id, chore.id, 1);
    expect(result.status).toBe(201);
  });

  it("メニュー名を変えても、過去の履歴の表示は変わらない", async () => {
    const home2 = await createHousehold({ capacity: 30 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 1);
    await home2.client.patch(`/api/chores/${home2.choreId}`, { name: "ぜんぜんちがう名前" });

    const history = await home2.client.get(`/api/members/${child.id}/history`);
    expect(history.body[0].choreLabel).toBe(home2.boot.chores[0]!.name);
  });
});

describe("交換", () => {
  it("満了 → リクエスト → ハンコ → 本棚 の流れが通る", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 5);
    const sheet = await currentSheet(home2.client, child.id);
    expect(sheet.status).toBe("full");

    const requested = await home2.client.post(`/api/sheets/${sheet.id}/request-redeem`, {});
    expect(requested.body.redeemRequestedAt).not.toBeNull();

    const redeemed = await home2.client.post(`/api/sheets/${sheet.id}/redeem`, {
      rewardText: "Robux 1200",
      category: "roblox",
      amountYen: 1500,
    });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.sheet.status).toBe("redeemed");
    expect(redeemed.body.nextSheet.status).toBe("active");
    expect(redeemed.body.nextSheet.filled).toBe(0);
    expect(redeemed.body.nextSheet.seqNo).toBe(sheet.seqNo + 1);

    const shelf = await home2.client.get(`/api/members/${child.id}/sheets`);
    expect(shelf.body).toHaveLength(1);
    expect(shelf.body[0].stickers).toHaveLength(5);

    const redemptions = await home2.client.get(`/api/members/${child.id}/redemptions`);
    expect(redemptions.body[0].rewardText).toBe("Robux 1200");
    expect(redemptions.body[0].amountYen).toBe(1500);
  });

  it("満了していない台帳は交換できない", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;
    await stick(home2.client, child.id, home2.choreId, 2);

    const sheet = await currentSheet(home2.client, child.id);
    expect((await home2.client.post(`/api/sheets/${sheet.id}/request-redeem`, {})).status).toBe(409);
    expect(
      (await home2.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "だめ" })).status,
    ).toBe(409);
  });

  it("同じ台帳を2回交換できない", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;
    await stick(home2.client, child.id, home2.choreId, 5);
    const sheet = await currentSheet(home2.client, child.id);

    await home2.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "1回目" });
    const again = await home2.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "2回目" });
    expect(again.status).toBe(409);
  });

  it("交換したものが空だと弾かれる", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;
    await stick(home2.client, child.id, home2.choreId, 5);
    const sheet = await currentSheet(home2.client, child.id);

    expect((await home2.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "" })).status).toBe(400);
  });

  it("交換ずみの台帳のシールは取り消せない", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;
    const grant = await stick(home2.client, child.id, home2.choreId, 5);
    const sheet = await currentSheet(home2.client, child.id);
    await home2.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "まんが" });

    const revoked = await home2.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {});
    expect(revoked.status).toBe(409);
  });

  /**
   * 繰り越しが起きると、1人が同時に2冊持つ(渡す前の満了した台帳 + いま貼っている台帳)。
   * 満了した台帳が bootstrap から抜け落ちると、渡す前の台帳が交換できなくなる。
   */
  it("繰り越しても、満了した台帳がハンコ待ちとして出てくる", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 7); // 1冊目満了 + 2冊目に2枚

    const boot = (await home2.client.get("/api/bootstrap")).body;
    expect(boot.sheets[child.id].seqNo).toBe(2);
    expect(boot.sheets[child.id].status).toBe("active");
    expect(boot.pendingSheets).toHaveLength(1);
    expect(boot.pendingSheets[0].seqNo).toBe(1);
    expect(boot.pendingSheets[0].filled).toBe(5);
  });

  it("繰り越し後の交換では、次の台帳を余分に発行しない", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 7);
    const boot = (await home2.client.get("/api/bootstrap")).body;
    const fullSheet = boot.pendingSheets[0];

    const redeemed = await home2.client.post(`/api/sheets/${fullSheet.id}/redeem`, {
      rewardText: "まんが",
    });
    expect(redeemed.status).toBe(200);
    // すでに2冊目が始まっているので、3冊目は作らない
    expect(redeemed.body.nextSheet.seqNo).toBe(2);

    const after = (await home2.client.get("/api/bootstrap")).body;
    expect(after.sheets[child.id].seqNo).toBe(2);
    expect(after.sheets[child.id].filled).toBe(2);
    expect(after.pendingSheets).toHaveLength(0);
  });

  it("ちょうど満了した台帳は、そのまま今の台帳としてもハンコ待ちとしても出る", async () => {
    const home2 = await createHousehold({ capacity: 5 });
    const child = home2.children[0]!;

    await stick(home2.client, child.id, home2.choreId, 5);

    const boot = (await home2.client.get("/api/bootstrap")).body;
    expect(boot.sheets[child.id].status).toBe("full");
    expect(boot.pendingSheets).toHaveLength(1);
    expect(boot.pendingSheets[0].id).toBe(boot.sheets[child.id].id);
  });
});

describe("端末を分けても同じ家庭が見える", () => {
  it("別の Cookie 入れからは何も見えない", async () => {
    const stranger = new Client();
    expect((await stranger.get("/api/bootstrap")).status).toBe(401);
    expect((await stranger.get("/api/chores")).status).toBe(401);
    expect((await stranger.post("/api/grants", {})).status).toBe(401);
  });
});
