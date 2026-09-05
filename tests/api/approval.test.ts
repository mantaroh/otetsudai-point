import { describe, expect, it } from "vitest";
import { Client, claimPath, createHousehold, currentSheet, stick, uuid } from "./client";

/**
 * 承認あり運用(require_approval = 1)。
 *
 * うちでは使わないが、他家庭では「勝手に貼られては困る」という要求が確実に出るので、
 * 設定として実装してある。使っていない経路こそ、テストで固めておかないと腐る。
 */

async function approvalHousehold() {
  const home = await createHousehold({ capacity: 5 });
  expect((await home.client.patch("/api/settings", { requireApproval: true })).status).toBe(200);

  const invite = await home.client.post("/api/devices/invites", {
    kind: "shared",
    label: "リビングのタブレット",
  });
  const tablet = new Client();
  await tablet.post(claimPath(invite.body.url));

  return { ...home, tablet };
}

describe("承認あり運用", () => {
  it("子が申請しても、承認されるまでシールは貼られない", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    const result = await stick(home.tablet, child.id, home.choreId, 2);
    expect(result.status).toBe(201);
    expect(result.body.grant.approvedAt).toBeNull();
    expect(result.body.becameFull).toBe(false);

    expect((await currentSheet(home.tablet, child.id)).filled).toBe(0);
  });

  it("申請が bootstrap の承認待ちに出る(親がここから承認する)", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;
    await stick(home.tablet, child.id, home.choreId, 2);

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.pendingGrants).toHaveLength(1);
    expect(boot.pendingGrants[0].memberId).toBe(child.id);
    expect(boot.pendingGrants[0].count).toBe(2);
    expect(boot.pendingGrants[0].approvedAt).toBeNull();

    // 承認すると、待ちから消えてシールになる
    await home.client.post(`/api/grants/${boot.pendingGrants[0].id}/approve`);
    const after = (await home.client.get("/api/bootstrap")).body;
    expect(after.pendingGrants).toHaveLength(0);
    expect(after.sheets[child.id].filled).toBe(2);
  });

  it("承認なし運用の家庭では、承認待ちは常に空", async () => {
    const home = await createHousehold({ capacity: 5 });
    await stick(home.client, home.children[0]!.id, home.choreId, 2);

    const boot = (await home.client.get("/api/bootstrap")).body;
    expect(boot.pendingGrants).toHaveLength(0);
  });

  it("子ども専用端末には、自分の申請しか出ない", async () => {
    const home = await approvalHousehold();
    const [hana, taro] = home.children;
    await stick(home.tablet, hana!.id, home.choreId, 1);
    await stick(home.tablet, taro!.id, home.choreId, 1);

    const invite = await home.client.post("/api/devices/invites", {
      kind: "child",
      label: "たろうのスマホ",
      memberId: taro!.id,
    });
    const phone = new Client();
    await phone.post(claimPath(invite.body.url));

    const boot = (await phone.get("/api/bootstrap")).body;
    expect(boot.pendingGrants).toHaveLength(1);
    expect(boot.pendingGrants[0].memberId).toBe(taro!.id);
  });

  it("申請は履歴に「しんせいちゅう」として残る", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;
    await stick(home.tablet, child.id, home.choreId, 1);

    const history = await home.client.get(`/api/members/${child.id}/history`);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].approvedAt).toBeNull();
    expect(history.body[0].revokedAt).toBeNull();
  });

  it("親が承認した時点でシールが発行される", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    const requested = await stick(home.tablet, child.id, home.choreId, 3);
    const approved = await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);

    expect(approved.status).toBe(200);
    expect(approved.body.grant.approvedAt).not.toBeNull();
    expect((await currentSheet(home.client, child.id)).filled).toBe(3);
  });

  it("承認でも台帳またぎが正しく起きる", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    const requested = await stick(home.tablet, child.id, home.choreId, 7);
    const approved = await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);

    expect(approved.body.becameFull).toBe(true);
    expect(approved.body.sheets.map((sheet: any) => sheet.filled)).toEqual([5, 2]);
  });

  it("承認は何度呼んでも二重に貼られない", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    const requested = await stick(home.tablet, child.id, home.choreId, 2);
    await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);
    const again = await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);

    expect(again.status).toBe(200);
    expect((await currentSheet(home.client, child.id)).filled).toBe(2);
  });

  it("承認には親の権限が要る", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;
    const requested = await stick(home.tablet, child.id, home.choreId, 1);

    const bySelf = await home.tablet.post(`/api/grants/${requested.body.grant.id}/approve`);
    expect(bySelf.status).toBe(401);
    expect(bySelf.body.error).toBe("pin_required");

    const withPin = await home.tablet.post(
      `/api/grants/${requested.body.grant.id}/approve`,
      undefined,
      { "X-Parent-Pin": "1234" },
    );
    expect(withPin.status).toBe(200);
  });

  it("親がつけたぶんは、承認あり運用でも即シールになる", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    // OAuth ログイン済みの親からの付与
    const result = await stick(home.client, child.id, home.choreId, 2);
    expect(result.body.grant.createdVia).toBe("parent");
    expect(result.body.grant.approvedAt).not.toBeNull();
    expect((await currentSheet(home.client, child.id)).filled).toBe(2);
  });

  it("申請を取り消したら、承認できなくなる", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    const requested = await stick(home.tablet, child.id, home.choreId, 1);
    await home.client.post(`/api/grants/${requested.body.grant.id}/revoke`, {});

    const approved = await home.client.post(`/api/grants/${requested.body.grant.id}/approve`);
    expect(approved.status).toBe(409);
    expect((await currentSheet(home.client, child.id)).filled).toBe(0);
  });

  it("存在しない申請は承認できない", async () => {
    const home = await approvalHousehold();
    expect((await home.client.post(`/api/grants/grt_${uuid()}/approve`)).status).toBe(404);
  });

  it("設定を戻せば、また即時に貼られるようになる", async () => {
    const home = await approvalHousehold();
    const child = home.children[0]!;

    await home.client.patch("/api/settings", { requireApproval: false });
    const result = await stick(home.tablet, child.id, home.choreId, 1);

    expect(result.body.grant.approvedAt).not.toBeNull();
    expect((await currentSheet(home.tablet, child.id)).filled).toBe(1);
  });
});

describe("子どもが貼れない運用", () => {
  it("allow_self_grant を切ると、共有端末からは貼れなくなる", async () => {
    const home = await createHousehold({ capacity: 5 });
    await home.client.patch("/api/settings", { allowSelfGrant: false });

    const invite = await home.client.post("/api/devices/invites", {
      kind: "shared",
      label: "タブレット",
    });
    const tablet = new Client();
    await tablet.post(claimPath(invite.body.url));

    const blocked = await stick(tablet, home.children[0]!.id, home.choreId, 1);
    expect(blocked.status).toBe(403);

    // 親としてなら貼れる
    const allowed = await tablet.post(
      "/api/grants",
      { memberId: home.children[0]!.id, choreId: home.choreId, count: 1, requestId: uuid(), asParent: true },
      { "X-Parent-Pin": "1234" },
    );
    expect(allowed.status).toBe(201);
    expect(allowed.body.grant.createdVia).toBe("parent");
  });
});
