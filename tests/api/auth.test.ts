import { describe, expect, it } from "vitest";
import {
  Client,
  claimPath,
  createHousehold,
  inviteToken,
  signInFresh,
  stick,
} from "./client";

/**
 * 認証とテナント分離。
 *
 * 他家庭に開くなら、ここが一番致命的になる。
 * 「見えてはいけないものが見えない」を、通る経路ごとに確かめる。
 */

async function inviteDevice(
  home: Awaited<ReturnType<typeof createHousehold>>,
  kind: "shared" | "child" | "parent",
  memberId?: string,
): Promise<Client> {
  const invite = await home.client.post("/api/devices/invites", {
    kind,
    label: `${kind} device`,
    memberId,
  });
  expect(invite.status).toBe(201);

  const device = new Client();
  const claimed = await device.post(claimPath(invite.body.url));
  expect(claimed.status).toBe(200);
  return device;
}

describe("未認証", () => {
  it("Cookie が無ければ何も見えない", async () => {
    const stranger = new Client();
    for (const path of ["/api/bootstrap", "/api/me", "/api/chores", "/api/settings", "/api/history"]) {
      expect((await stranger.get(path)).status).toBe(401);
    }
  });

  it("ログインしていないと家庭を作れない", async () => {
    const stranger = new Client();
    const result = await stranger.post("/api/families", {
      familyName: "のっとり家",
      parentName: "だれか",
      pin: "1111",
      children: [{ name: "こ" }],
    });
    expect(result.status).toBe(401);
  });
});

describe("Cookie の改竄", () => {
  it("署名のない家庭 Cookie は効かない", async () => {
    const home = await createHousehold();
    const attacker = new Client();
    await signInFresh(attacker);

    // 署名部分を捨てた生の値をそのまま入れてみる
    attacker.setCookie("op_f", btoa(JSON.stringify({ fid: home.familyId, exp: 9e12 })));
    expect((await attacker.get("/api/bootstrap")).status).toBe(401);
  });

  it("署名を書き換えた家庭 Cookie は効かない", async () => {
    const home = await createHousehold();
    const cookie = home.client.getCookie("op_f")!;
    const [body] = cookie.split(".");

    const attacker = new Client();
    await signInFresh(attacker);
    attacker.setCookie("op_f", `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    expect((await attacker.get("/api/bootstrap")).status).toBe(401);
  });

  /**
   * 署名としては本物の家庭 Cookie を、別のユーザーのセッションに差し込む。
   * 署名だけを見て通してしまうと、ここで他家庭に入れてしまう。
   */
  it("正しく署名された他家庭の Cookie でも、所属していなければ入れない", async () => {
    const victim = await createHousehold({ familyName: "ひがい家" });
    const stolen = victim.client.getCookie("op_f")!;

    const attacker = new Client();
    await signInFresh(attacker);
    attacker.setCookie("op_f", stolen);

    // 家庭の所属を毎回確かめているので、ここで弾かれる
    expect((await attacker.get("/api/bootstrap")).status).toBe(401);
  });

  it("でたらめな端末トークンでは入れない", async () => {
    const stranger = new Client();
    stranger.setCookie("op_d", "not-a-real-device-token-0123456789");
    expect((await stranger.get("/api/bootstrap")).status).toBe(401);
  });

  it("ログアウトすると Cookie が消える", async () => {
    const home = await createHousehold();
    expect((await home.client.get("/api/bootstrap")).status).toBe(200);

    await home.client.post("/auth/logout");
    expect((await home.client.get("/api/bootstrap")).status).toBe(401);
  });
});

describe("他家庭のデータ", () => {
  it("あらゆる経路で 404 になる", async () => {
    const victim = await createHousehold({ familyName: "ひがい家" });
    const attacker = await createHousehold({ familyName: "こうげき家" });

    const child = victim.children[0]!;
    const grant = await stick(victim.client, child.id, victim.choreId, 5);
    const sheet = (await victim.client.get("/api/bootstrap")).body.pendingSheets[0];

    // 読み取り
    expect((await attacker.client.get(`/api/members/${child.id}/history`)).status).toBe(404);
    expect((await attacker.client.get(`/api/members/${child.id}/sheets`)).status).toBe(404);
    expect((await attacker.client.get(`/api/members/${child.id}/redemptions`)).status).toBe(404);

    // 書き込み
    expect((await stick(attacker.client, child.id, attacker.choreId, 1)).status).toBe(404);
    expect((await attacker.client.post(`/api/grants/${grant.body.grant.id}/revoke`, {})).status).toBe(404);
    expect(
      (await attacker.client.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "のっとり" })).status,
    ).toBe(404);
    expect((await attacker.client.post(`/api/sheets/${sheet.id}/request-redeem`, {})).status).toBe(404);
    expect((await attacker.client.patch(`/api/chores/${victim.choreId}`, { name: "改竄" })).status).toBe(404);
  });

  it("他家庭のお手伝いメニューは使えない", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();

    const result = await stick(attacker.client, attacker.children[0]!.id, victim.choreId, 1);
    expect(result.status).toBe(404);
  });

  it("他家庭のメンバーを端末に紐づけられない", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();

    const result = await attacker.client.post("/api/devices/invites", {
      kind: "child",
      label: "のっとり端末",
      memberId: victim.children[0]!.id,
    });
    expect(result.status).toBe(400);
  });

  it("エクスポートには自分の家庭のぶんしか入らない", async () => {
    const victim = await createHousehold({ familyName: "ひがい家" });
    await stick(victim.client, victim.children[0]!.id, victim.choreId, 2);
    const attacker = await createHousehold({ familyName: "こうげき家" });

    const exported = await attacker.client.get("/api/export");
    expect(exported.status).toBe(200);
    expect(exported.body.data.members.every((m: any) => m.family_id === attacker.familyId)).toBe(true);
    expect(exported.body.data.stickers).toHaveLength(0);
  });

  it("エクスポートに PIN のハッシュは含まれない", async () => {
    const home = await createHousehold();
    const exported = await home.client.get("/api/export");
    expect(exported.body.data.families[0]).not.toHaveProperty("pin_hash");
  });

  it("URL に他家庭の ID を書いても削除できない", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();

    expect((await attacker.client.del(`/api/families/${victim.familyId}`)).status).toBe(404);
    expect((await victim.client.get("/api/bootstrap")).status).toBe(200);
  });
});

describe("端末登録", () => {
  it("招待リンクを開くと、ログインなしで使えるようになる", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");

    const boot = await tablet.get("/api/bootstrap");
    expect(boot.status).toBe(200);
    expect(boot.body.auth.kind).toBe("device");
    expect(boot.body.auth.needsPin).toBe(true);
    expect(boot.body.auth.lockedMemberId).toBeNull();
  });

  it("招待リンクは使い捨て", async () => {
    const home = await createHousehold();
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "タブレット",
    });

    expect((await new Client().post(claimPath(invite.body.url))).status).toBe(200);
    expect((await new Client().post(claimPath(invite.body.url))).status).toBe(400);
  });

  it("でたらめな招待リンクは通らない", async () => {
    expect((await new Client().post("/api/invites/でたらめ/claim")).status).toBe(404);
    expect((await new Client().get("/api/invites/でたらめ")).body.status).toBe("unknown");
  });

  /**
   * LINE に招待リンクを送ったら、リンクプレビューの取得に使い切られて
   * 「このリンクは使用ずみです」になった。
   *
   * リンクを「開く」のは、本人とは限らない。
   * プレビュー取得、メールのセキュリティスキャン、ブラウザの先読み、
   * どれも GET を投げてくる。開くだけでは何も起こらないことを担保する。
   */
  it("リンクプレビューに踏まれても、招待は生きたまま残る", async () => {
    const home = await createHousehold();
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "リビングのタブレット",
    });
    const token = inviteToken(invite.body.url);

    // プレビュー取得のように、リンクを何度も GET する
    const bot = new Client();
    for (let i = 0; i < 3; i++) {
      const peeked = await bot.get(`/api/invites/${token}`);
      expect(peeked.status).toBe(200);
      expect(peeked.body.status).toBe("ok");
    }

    // 覗いただけでは端末は増えない
    expect((await home.client.get("/api/devices")).body).toHaveLength(0);
    // 覗いた側に Cookie も渡っていない
    expect((await bot.get("/api/bootstrap")).status).toBe(401);

    // そのあとで、本人がちゃんと登録できる
    const tablet = new Client();
    expect((await tablet.post(claimPath(invite.body.url))).status).toBe(200);
    expect((await tablet.get("/api/bootstrap")).status).toBe(200);
  });

  it("招待の中身は、消費せずに確認できる", async () => {
    const home = await createHousehold({ familyName: "やまだ家" });
    const child = home.children[0]!;
    const invite = await home.client.post("/api/devices/invites", {
      kind: "child",
      label: "はなのスマホ",
      memberId: child.id,
    });

    const peeked = await new Client().get(`/api/invites/${inviteToken(invite.body.url)}`);
    expect(peeked.body).toMatchObject({
      status: "ok",
      familyName: "やまだ家",
      label: "はなのスマホ",
      kind: "child",
      memberName: child.name,
    });
  });

  it("使用ずみ・期限切れが、引き換える前に分かる", async () => {
    const home = await createHousehold();
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "タブレット",
    });
    const token = inviteToken(invite.body.url);

    await new Client().post(claimPath(invite.body.url));
    expect((await new Client().get(`/api/invites/${token}`)).body.status).toBe("used");
  });

  it("共有端末からは、子が自分でシールを貼れる", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");

    const result = await stick(tablet, home.children[0]!.id, home.choreId, 1);
    expect(result.status).toBe(201);
    expect(result.body.grant.createdVia).toBe("self");
  });

  it("子ども専用端末は、自分の台帳しか触れない", async () => {
    const home = await createHousehold();
    const [hana, taro] = home.children;
    const phone = await inviteDevice(home, "child", taro!.id);

    const boot = await phone.get("/api/bootstrap");
    expect(boot.body.auth.lockedMemberId).toBe(taro!.id);
    // 自分の台帳しか入っていない
    expect(Object.keys(boot.body.sheets)).toEqual([taro!.id]);

    expect((await phone.get(`/api/members/${hana!.id}/history`)).status).toBe(404);
    expect((await stick(phone, hana!.id, home.choreId, 1)).status).toBe(404);
    expect((await stick(phone, taro!.id, home.choreId, 1)).status).toBe(201);
  });

  it("失効させた端末は使えなくなる", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");
    expect((await tablet.get("/api/bootstrap")).status).toBe(200);

    const devices = await home.client.get("/api/devices");
    const target = devices.body.find((device: any) => device.kind === "shared");
    expect((await home.client.del(`/api/devices/${target.id}`)).status).toBe(200);

    expect((await tablet.get("/api/bootstrap")).status).toBe(401);
  });
});

describe("親の PIN", () => {
  it("共有端末では、親操作に PIN が要る", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");
    const child = home.children[0]!;
    await stick(tablet, child.id, home.choreId, 5);

    const sheet = (await tablet.get("/api/bootstrap")).body.pendingSheets[0];
    const noPin = await tablet.post(`/api/sheets/${sheet.id}/redeem`, { rewardText: "だめ" });
    expect(noPin.status).toBe(401);
    expect(noPin.body.error).toBe("pin_required");
  });

  it("PIN を通すと、しばらく続けて親操作ができる", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");

    expect((await tablet.post("/api/pin/verify", { pin: "9999" })).status).toBe(401);
    expect((await tablet.post("/api/pin/verify", { pin: "1234" })).status).toBe(200);

    // チケットが効いているので、PIN を再入力せずに続けられる
    expect((await tablet.patch("/api/settings", { siblingsVisible: true })).status).toBe(200);
    expect((await tablet.get("/api/devices")).status).toBe(200);
  });

  it("ヘッダで PIN を直接渡してもよい", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");

    const result = await tablet.patch("/api/settings", { capacity: 20 }, { "X-Parent-Pin": "1234" });
    expect(result.status).toBe(200);
    expect(result.body.capacity).toBe(20);
  });

  it("OAuth でログイン済みの親には PIN を求めない", async () => {
    const home = await createHousehold();
    expect(home.boot.auth.canActAsParent).toBe(true);
    expect((await home.client.patch("/api/settings", { capacity: 40 })).status).toBe(200);
  });

  it("続けて間違えるとロックされる", async () => {
    // ロックは家庭単位なので、他のテストに巻き込まれない家庭を用意する
    const home = await createHousehold({ pin: "8642" });
    const tablet = await inviteDevice(home, "shared");

    for (let attempt = 0; attempt < 5; attempt++) {
      await tablet.post("/api/pin/verify", { pin: "0000" });
    }

    const locked = await tablet.post("/api/pin/verify", { pin: "8642" });
    expect(locked.status).toBe(401);
    expect(locked.body.lockedUntil).toBeGreaterThan(Date.now());

    // 正しい PIN をヘッダで渡しても、ロック中は通らない
    const blocked = await tablet.patch("/api/settings", { capacity: 20 }, { "X-Parent-Pin": "8642" });
    expect(blocked.status).toBe(429);
  });

  it("PIN の形式が不正なら弾かれる", async () => {
    const home = await createHousehold();
    const tablet = await inviteDevice(home, "shared");
    for (const pin of ["123", "abcd", "", "123456789"]) {
      expect((await tablet.post("/api/pin/verify", { pin })).status).toBe(400);
    }
  });
});

describe("複数の家庭に属する場合", () => {
  it("切り替えると、見えるものが入れ替わる", async () => {
    const client = new Client();
    await signInFresh(client);

    const first = await client.post("/api/families", {
      familyName: "いえA",
      parentName: "おや",
      pin: "1234",
      capacity: 5,
      children: [{ name: "あ" }],
    });
    const second = await client.post("/api/families", {
      familyName: "いえB",
      parentName: "おや",
      pin: "1234",
      capacity: 5,
      children: [{ name: "い" }],
    });

    expect((await client.get("/api/bootstrap")).body.family.name).toBe("いえB");

    const me = await client.get("/api/me");
    expect(me.body.families).toHaveLength(2);

    await client.post("/api/session/family", { familyId: first.body.familyId });
    expect((await client.get("/api/bootstrap")).body.family.name).toBe("いえA");

    await client.post("/api/session/family", { familyId: second.body.familyId });
    expect((await client.get("/api/bootstrap")).body.family.name).toBe("いえB");
  });

  it("所属していない家庭には切り替えられない", async () => {
    const victim = await createHousehold();
    const attacker = new Client();
    await signInFresh(attacker);

    const result = await attacker.post("/api/session/family", { familyId: victim.familyId });
    expect(result.status).toBe(404);
  });
});
