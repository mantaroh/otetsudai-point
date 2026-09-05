import { describe, expect, it } from "vitest";
import { Client, claimPath, createHousehold, stick, uuid } from "./client";

/**
 * メンバーの表示情報の変更。
 *
 * 名前は変わる。呼び名が変わることもあれば、下の子が自分で決め直すこともある。
 * はじめの設定で「あとから変えられます」と書いておきながら変えられない、
 * という状態にしないための一式。
 */

async function sharedTablet(home: Awaited<ReturnType<typeof createHousehold>>): Promise<Client> {
  const invite = await home.client.post("/api/devices/invites", {
    kind: "shared",
    label: "タブレット",
  });
  const tablet = new Client();
  await tablet.post(claimPath(invite.body.url));
  return tablet;
}

describe("名前の変更", () => {
  it("子どもの名前を変えられる", async () => {
    const home = await createHousehold({ childNames: ["はな", "たろう"] });
    const hana = home.children[0]!;

    const updated = await home.client.patch(`/api/members/${hana.id}`, { name: "はなこ" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("はなこ");

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.members.find((m: any) => m.id === hana.id).name).toBe("はなこ");
  });

  it("おうちの人の名前も変えられる", async () => {
    const home = await createHousehold();
    const parent = home.boot.members.find((member) => member.role === "parent")!;

    const updated = await home.client.patch(`/api/members/${parent.id}`, { name: "ママ" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("ママ");
  });

  it("アイコンと色も変えられる", async () => {
    const home = await createHousehold();
    const hana = home.children[0]!;

    const updated = await home.client.patch(`/api/members/${hana.id}`, {
      avatar: "🐰",
      color: "#5BC0EB",
    });
    expect(updated.body.avatar).toBe("🐰");
    // 色は小文字にそろえて保存する
    expect(updated.body.color).toBe("#5bc0eb");
  });

  it("一部だけ指定しても、他の項目は変わらない", async () => {
    const home = await createHousehold();
    const hana = home.children[0]!;
    const before = (await home.client.get("/api/bootstrap")).body.members.find(
      (m: any) => m.id === hana.id,
    );

    await home.client.patch(`/api/members/${hana.id}`, { name: "はなこ" });

    const after = (await home.client.get("/api/bootstrap")).body.members.find(
      (m: any) => m.id === hana.id,
    );
    expect(after.name).toBe("はなこ");
    expect(after.avatar).toBe(before.avatar);
    expect(after.color).toBe(before.color);
  });

  it("前後の空白は落とす", async () => {
    const home = await createHousehold();
    const updated = await home.client.patch(`/api/members/${home.children[0]!.id}`, {
      name: "  はなこ  ",
    });
    expect(updated.body.name).toBe("はなこ");
  });

  /**
   * 名前は表示のためだけに持っている。同じ人のままなので、
   * 過去の記録も新しい名前で出るのが正しい。
   * (「何をしたか」= chore_label は凍結してあり、そちらは追随しない)
   */
  it("過去の記録の表示も、新しい名前になる", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    const tablet = await sharedTablet(home);

    await stick(tablet, hana.id, home.choreId, 1);
    await home.client.patch(`/api/members/${hana.id}`, { name: "はなこ" });

    const history = await home.client.get(`/api/members/${hana.id}/history`);
    expect(history.body[0].createdByName).toBe("はなこ");
  });

  it("お手伝いの名前は、メンバー名を変えても凍結されたまま", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 1);

    await home.client.patch(`/api/members/${hana.id}`, { name: "はなこ" });

    const history = await home.client.get(`/api/members/${hana.id}/history`);
    expect(history.body[0].choreLabel).toBe(home.boot.chores[0]!.name);
  });

  it("台帳はそのまま引き継がれる", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 3);

    await home.client.patch(`/api/members/${hana.id}`, { name: "はなこ" });

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.sheets[hana.id].filled).toBe(3);
  });
});

describe("家族をふやす", () => {
  it("子どもを追加すると、その場で1さつめの台帳が始まる", async () => {
    const home = await createHousehold({ capacity: 20 });

    const added = await home.client.post("/api/members", { name: "みなみ", role: "child" });
    expect(added.status).toBe(201);
    expect(added.body.role).toBe("child");
    expect(added.body.name).toBe("みなみ");

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.members.some((m: any) => m.id === added.body.id)).toBe(true);
    expect(boot.sheets[added.body.id]).toMatchObject({ seqNo: 1, filled: 0, capacity: 20 });
  });

  it("追加した子に、すぐシールを貼れる", async () => {
    const home = await createHousehold({ capacity: 20 });
    const added = await home.client.post("/api/members", { name: "みなみ", role: "child" });

    const result = await stick(home.client, added.body.id, home.choreId, 2);
    expect(result.status).toBe(201);
    expect(result.body.sheets[0].filled).toBe(2);
  });

  it("おうちの人も追加できる(台帳は作らない)", async () => {
    const home = await createHousehold();
    const added = await home.client.post("/api/members", { name: "おかあさん", role: "parent" });

    expect(added.body.role).toBe("parent");
    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.sheets[added.body.id]).toBeUndefined();
  });

  it("色は、すでに使われていないものが選ばれる", async () => {
    const home = await createHousehold({ childNames: ["はな", "たろう"] });
    const used = home.children.map((child) => child.color);

    const added = await home.client.post("/api/members", { name: "みなみ", role: "child" });
    expect(used).not.toContain(added.body.color);
  });

  it("色やアイコンを指定して追加できる", async () => {
    const home = await createHousehold();
    const added = await home.client.post("/api/members", {
      name: "みなみ",
      role: "child",
      avatar: "🐼",
      color: "#A06CD5",
    });
    expect(added.body.avatar).toBe("🐼");
    expect(added.body.color).toBe("#a06cd5");
  });

  it("名前が空なら弾かれる", async () => {
    const home = await createHousehold();
    expect((await home.client.post("/api/members", { name: "", role: "child" })).status).toBe(400);
  });

  it("共有端末からは PIN が要る", async () => {
    const home = await createHousehold();
    const tablet = await sharedTablet(home);

    expect((await tablet.post("/api/members", { name: "かってに", role: "child" })).status).toBe(401);
    expect(
      (
        await tablet.post("/api/members", { name: "みなみ", role: "child" }, { "X-Parent-Pin": "1234" })
      ).status,
    ).toBe(201);
  });
});

describe("家族からはずす", () => {
  it("はずすと一覧から消えるが、記録は残る", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 3);

    const removed = await home.client.del(`/api/members/${hana.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.purged).toBe(false);

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.members.some((m: any) => m.id === hana.id)).toBe(false);
    // 台帳も出てこない
    expect(boot.sheets[hana.id]).toBeUndefined();

    // しまってある人として残っている
    const archived = await home.client.get("/api/members/archived");
    expect(archived.body.map((m: any) => m.id)).toContain(hana.id);
  });

  it("はずした子には、もうシールを貼れない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await home.client.del(`/api/members/${hana.id}`);

    expect((await stick(home.client, hana.id, home.choreId, 1)).status).toBe(404);
    expect((await home.client.get(`/api/members/${hana.id}/history`)).status).toBe(404);
  });

  it("もどすと、そのときの台帳から続けられる", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 3);

    await home.client.del(`/api/members/${hana.id}`);
    const restored = await home.client.post(`/api/members/${hana.id}/restore`);
    expect(restored.status).toBe(200);

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.sheets[hana.id].filled).toBe(3);
    const history = await home.client.get(`/api/members/${hana.id}/history`);
    expect(history.body).toHaveLength(1);
  });

  it("最後のお子さんは、はずせない", async () => {
    const home = await createHousehold({ childNames: ["ひとり"] });
    const result = await home.client.del(`/api/members/${home.children[0]!.id}`);
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("お子さんが1人もいなくなって");
  });

  it("最後のおうちの人も、はずせない", async () => {
    const home = await createHousehold();
    const parent = home.boot.members.find((member) => member.role === "parent")!;
    const result = await home.client.del(`/api/members/${parent.id}`);
    expect(result.status).toBe(409);
  });
});

describe("完全に削除", () => {
  it("記録が無ければ完全に消せる", async () => {
    const home = await createHousehold();
    const added = await home.client.post("/api/members", { name: "まちがえた", role: "child" });

    const removed = await home.client.del(`/api/members/${added.body.id}?purge=1`);
    expect(removed.status).toBe(200);
    expect(removed.body.purged).toBe(true);

    const archived = await home.client.get("/api/members/archived");
    expect(archived.body.map((m: any) => m.id)).not.toContain(added.body.id);
    expect((await home.client.post(`/api/members/${added.body.id}/restore`)).status).toBe(404);
  });

  /** シールや交換の記録があるメンバーを消せてしまうと、取り返しがつかない */
  it("記録が1件でもあれば、完全には消せない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 1);

    const result = await home.client.del(`/api/members/${hana.id}?purge=1`);
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("しまう");

    // 残っている
    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.members.some((m: any) => m.id === hana.id)).toBe(true);
  });

  it("しまったあとでも、記録があれば完全には消せない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const hana = home.children[0]!;
    await stick(home.client, hana.id, home.choreId, 1);
    await home.client.del(`/api/members/${hana.id}`);

    expect((await home.client.del(`/api/members/${hana.id}?purge=1`)).status).toBe(409);
  });

  it("その子専用の端末は、削除と一緒に使えなくなる", async () => {
    const home = await createHousehold();
    const added = await home.client.post("/api/members", { name: "みなみ", role: "child" });

    const invite = await home.client.post("/api/devices/invites", {
      kind: "child",
      label: "みなみのスマホ",
      memberId: added.body.id,
    });
    const phone = new Client();
    await phone.post(claimPath(invite.body.url));
    expect((await phone.get("/api/bootstrap")).status).toBe(200);

    await home.client.del(`/api/members/${added.body.id}?purge=1`);
    expect((await phone.get("/api/bootstrap")).status).toBe(401);
  });
});

describe("入力の検証", () => {
  it("空の名前は弾かれる", async () => {
    const home = await createHousehold();
    const id = home.children[0]!.id;
    expect((await home.client.patch(`/api/members/${id}`, { name: "" })).status).toBe(400);
    expect((await home.client.patch(`/api/members/${id}`, { name: "   " })).status).toBe(400);
  });

  it("長すぎる名前は弾かれる", async () => {
    const home = await createHousehold();
    const result = await home.client.patch(`/api/members/${home.children[0]!.id}`, {
      name: "あ".repeat(21),
    });
    expect(result.status).toBe(400);
  });

  it("色の形式が不正なら弾かれる", async () => {
    const home = await createHousehold();
    const id = home.children[0]!.id;
    for (const color of ["red", "#fff", "#12345g", "javascript:alert(1)", ""]) {
      expect((await home.client.patch(`/api/members/${id}`, { color })).status).toBe(400);
    }
  });

  it("何も指定しなければ、そのまま返るだけ", async () => {
    const home = await createHousehold();
    const hana = home.children[0]!;
    const result = await home.client.patch(`/api/members/${hana.id}`, {});
    expect(result.status).toBe(200);
    expect(result.body.name).toBe(hana.name);
  });
});

describe("権限とスコープ", () => {
  it("共有端末からは PIN が要る", async () => {
    const home = await createHousehold();
    const tablet = await sharedTablet(home);
    const id = home.children[0]!.id;

    const noPin = await tablet.patch(`/api/members/${id}`, { name: "かってに" });
    expect(noPin.status).toBe(401);
    expect(noPin.body.error).toBe("pin_required");

    const withPin = await tablet.patch(
      `/api/members/${id}`,
      { name: "はなこ" },
      { "X-Parent-Pin": "1234" },
    );
    expect(withPin.status).toBe(200);
  });

  it("他家庭のメンバーは変えられない", async () => {
    const victim = await createHousehold({ familyName: "ひがい家" });
    const attacker = await createHousehold({ familyName: "こうげき家" });

    const result = await attacker.client.patch(`/api/members/${victim.children[0]!.id}`, {
      name: "のっとり",
    });
    expect(result.status).toBe(404);

    // 元の名前のまま
    const boot = (await victim.client.get("/api/bootstrap")).body;
    expect(boot.members.find((m: any) => m.id === victim.children[0]!.id).name).toBe(
      victim.children[0]!.name,
    );
  });

  it("存在しないメンバーは 404", async () => {
    const home = await createHousehold();
    expect((await home.client.patch(`/api/members/mem_${uuid()}`, { name: "だれ" })).status).toBe(404);
  });

  it("未認証では変えられない", async () => {
    const home = await createHousehold();
    const stranger = new Client();
    expect(
      (await stranger.patch(`/api/members/${home.children[0]!.id}`, { name: "だれ" })).status,
    ).toBe(401);
  });

  it("他家庭のメンバーは、はずせない・戻せない", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();
    const id = victim.children[0]!.id;

    expect((await attacker.client.del(`/api/members/${id}`)).status).toBe(404);
    expect((await attacker.client.post(`/api/members/${id}/restore`)).status).toBe(404);

    const boot = (await victim.client.get("/api/bootstrap")).body;
    expect(boot.members.some((m: any) => m.id === id)).toBe(true);
  });

  it("しまってある人の一覧も、家庭ごとに分かれている", async () => {
    const victim = await createHousehold();
    await victim.client.del(`/api/members/${victim.children[0]!.id}`);

    const attacker = await createHousehold();
    const archived = await attacker.client.get("/api/members/archived");
    expect(archived.body).toHaveLength(0);
  });
});

describe("端末の名前", () => {
  async function registerTablet(home: Awaited<ReturnType<typeof createHousehold>>) {
    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "なまえ未設定",
    });
    const device = new Client();
    await device.post(claimPath(invite.body.url));
    const list = await home.client.get("/api/devices");
    return list.body[0];
  }

  it("あとから変えられる", async () => {
    const home = await createHousehold();
    const device = await registerTablet(home);

    const updated = await home.client.patch(`/api/devices/${device.id}`, {
      label: "リビングのiPad",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.label).toBe("リビングのiPad");

    const list = await home.client.get("/api/devices");
    expect(list.body[0].label).toBe("リビングのiPad");
  });

  /** 何ができる端末なのかが、名前を見なくても分かるようにしておく */
  it("種類は変わらない", async () => {
    const home = await createHousehold();
    const device = await registerTablet(home);

    const updated = await home.client.patch(`/api/devices/${device.id}`, {
      label: "べつの名前",
      kind: "parent",
    });
    expect(updated.body.kind).toBe("shared");
  });

  it("空の名前は弾かれる", async () => {
    const home = await createHousehold();
    const device = await registerTablet(home);
    expect((await home.client.patch(`/api/devices/${device.id}`, { label: "  " })).status).toBe(400);
  });

  it("失効させた端末の名前は変えられない", async () => {
    const home = await createHousehold();
    const device = await registerTablet(home);
    await home.client.del(`/api/devices/${device.id}`);

    expect((await home.client.patch(`/api/devices/${device.id}`, { label: "x" })).status).toBe(404);
  });

  it("他家庭の端末の名前は変えられない", async () => {
    const victim = await createHousehold();
    const device = await registerTablet(victim);
    const attacker = await createHousehold();

    expect((await attacker.client.patch(`/api/devices/${device.id}`, { label: "のっとり" })).status).toBe(404);
  });

  it("共有端末からは PIN が要る", async () => {
    const home = await createHousehold();
    const device = await registerTablet(home);
    const tablet = await sharedTablet(home);

    expect((await tablet.patch(`/api/devices/${device.id}`, { label: "x" })).status).toBe(401);
    expect(
      (await tablet.patch(`/api/devices/${device.id}`, { label: "ok" }, { "X-Parent-Pin": "1234" }))
        .status,
    ).toBe(200);
  });
});
