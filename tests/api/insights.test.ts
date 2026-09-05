import { describe, expect, it } from "vitest";
import type { UiEventInput, UiInsights } from "../../src/shared/types";
import { Client, claimPath, createHousehold, uuid } from "./client";

/**
 * 画面の操作記録と、その集計。
 *
 * 押さえどころ:
 *   - 再送しても二重に数えない(端末は sendBeacon で投げっぱなしにする)
 *   - **自由入力が入らない**。ここが緩むと、お手伝いの名前や交換したものが混ざる
 *   - 他家庭の記録は1件も見えない
 *   - 「記録しない」設定と「消す」が本当に効く
 */

type Household = Awaited<ReturnType<typeof createHousehold>>;

function sessionId(): string {
  return uuid().replace(/-/g, "");
}

async function sendEvents(
  client: Client,
  session: string,
  events: UiEventInput[],
  now = Date.now(),
  appVersion?: string,
) {
  return client.post("/api/ui-events", { sessionId: session, now, events, appVersion });
}

/** 台帳を開いて、お手伝いを選んで、1枚貼った1回ぶん */
function visit(memberId: string, from = 0): UiEventInput[] {
  const t = Date.now();
  return [
    { seq: from, t, screen: "ledger", type: "view", name: "enter", memberId },
    { seq: from + 1, t: t + 1000, screen: "ledger", type: "action", name: "chore-pick", memberId },
    {
      seq: from + 2,
      t: t + 2000,
      screen: "ledger",
      type: "action",
      name: "stick",
      value: 1,
      memberId,
    },
    {
      seq: from + 3,
      t: t + 2000,
      screen: "ledger",
      type: "flow",
      name: "first-sticker",
      value: 2000,
      memberId,
    },
    {
      seq: from + 4,
      t: t + 2000,
      screen: "ledger",
      type: "flow",
      name: "first-sticker-taps",
      value: 3,
      memberId,
    },
    {
      seq: from + 5,
      t: t + 9000,
      screen: "ledger",
      type: "leave",
      name: "exit",
      value: 9000,
      memberId,
    },
  ];
}

async function insights(home: Household, days = 30): Promise<UiInsights> {
  const result = await home.client.get(`/api/insights?days=${days}`);
  expect(result.status).toBe(200);
  return result.body as UiInsights;
}

describe("操作記録の受け取り", () => {
  it("送ったぶんが集計に出る", async () => {
    const home = await createHousehold();
    const child = home.children[0]!;

    expect((await sendEvents(home.client, sessionId(), visit(child.id))).status).toBe(204);

    const report = await insights(home);
    expect(report.sessions).toBe(1);
    expect(report.events).toBe(6);
    expect(report.funnel).toEqual({ opened: 1, picked: 1, stuck: 1 });
    expect(report.firstSticker.p50Ms).toBe(2000);
    expect(report.firstSticker.medianTaps).toBe(3);
    expect(report.screens).toContainEqual(
      expect.objectContaining({ screen: "ledger", views: 1, medianDwellMs: 9000 }),
    );
    expect(report.members).toContainEqual(
      expect.objectContaining({ memberId: child.id, sticks: 1, medianFirstStickerMs: 2000 }),
    );
  });

  /**
   * 端末は sendBeacon で投げっぱなしにするので、同じぶんが2回届くことがある。
   * (session_id, seq) の UNIQUE で握りつぶす。
   */
  it("同じセッションの同じ連番は、何度送っても1件", async () => {
    const home = await createHousehold();
    const session = sessionId();
    const events = visit(home.children[0]!.id);

    await sendEvents(home.client, session, events);
    await sendEvents(home.client, session, events);
    await sendEvents(home.client, session, events);

    expect((await insights(home)).events).toBe(events.length);
  });

  it("別セッションなら、連番が同じでも別々に数える", async () => {
    const home = await createHousehold();
    const child = home.children[0]!;

    await sendEvents(home.client, sessionId(), visit(child.id));
    await sendEvents(home.client, sessionId(), visit(child.id));

    const report = await insights(home);
    expect(report.sessions).toBe(2);
    expect(report.funnel.stuck).toBe(2);
  });

  /**
   * 端末の時計は当てにならない。1年ずれたタブレットから来ても、
   * 集計の期間に収まる位置に置き直す。
   */
  it("端末の時計がずれていても、集計の窓から落ちない", async () => {
    const home = await createHousehold();
    const lastYear = Date.now() - 365 * 86_400_000;

    await sendEvents(
      home.client,
      sessionId(),
      [{ seq: 0, t: lastYear, screen: "home", type: "view", name: "enter" }],
      lastYear,
    );

    // 7日の窓でも見える = サーバの時計に寄せられている
    expect((await insights(home, 7)).events).toBe(1);
  });

  it("1回に送れる数を超えたら断る", async () => {
    const home = await createHousehold();
    const many = Array.from({ length: 41 }, (_, index) => ({
      seq: index,
      t: Date.now(),
      screen: "home",
      type: "view" as const,
      name: "enter",
    }));

    expect((await sendEvents(home.client, sessionId(), many)).status).toBe(400);
  });
});

describe("自由入力を混ぜられない", () => {
  const cases: Array<[string, UiEventInput]> = [
    [
      "detail にお手伝いの名前",
      { seq: 0, t: Date.now(), screen: "ledger", type: "action", name: "stick", detail: "おふろそうじ" },
    ],
    [
      "name に日本語",
      { seq: 0, t: Date.now(), screen: "ledger", type: "action", name: "シールをはる" },
    ],
    [
      "screen に日本語",
      { seq: 0, t: Date.now(), screen: "だいちょう", type: "view", name: "enter" },
    ],
    [
      "知らない type",
      { seq: 0, t: Date.now(), screen: "ledger", type: "keystroke" as never, name: "typed" },
    ],
  ];

  /**
   * 400 でバッチごと落とすと、同じ送信に入っていた正常な行まで巻き添えで消える。
   * 端末は投げっぱなしで再送しないので、消えたぶんは二度と来ない。
   * 捨てるのはその行だけにして、捨てたことは dropped として残す。
   */
  it.each(cases)("%s は、その行だけ捨てられる", async (_label, event) => {
    const home = await createHousehold();
    const ok: UiEventInput = {
      seq: 1,
      t: Date.now(),
      screen: "ledger",
      type: "action",
      name: "stick",
      value: 1,
    };

    const result = await sendEvents(home.client, sessionId(), [event, ok]);
    expect(result.status).toBe(204);

    const report = await insights(home);
    // 正しい行は入る
    expect(report.actions).toContainEqual(expect.objectContaining({ name: "stick", count: 1 }));
    // 捨てたことが集計に出る。これが出ているなら、送る側との取り決めがずれている
    expect(report.errors).toContainEqual(expect.objectContaining({ name: "dropped", count: 1 }));
    expect(report.events).toBe(2);
  });

  it("捨てた行の中身は、記録のどこにも残らない", async () => {
    const home = await createHousehold();

    await sendEvents(home.client, sessionId(), [
      {
        seq: 0,
        t: Date.now(),
        screen: "ledger",
        type: "action",
        name: "stick",
        detail: "おふろそうじ",
      },
    ]);

    const exported = await home.client.get("/api/export");
    expect(JSON.stringify(exported.body.data.ui_events)).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });
});

describe("記録の出どころ", () => {
  it("どのビルドから来た記録かが残る", async () => {
    const home = await createHousehold();

    await sendEvents(
      home.client,
      sessionId(),
      [{ seq: 0, t: Date.now(), screen: "home", type: "view", name: "enter" }],
      Date.now(),
      "202608231530",
    );

    const exported = await home.client.get("/api/export");
    expect(exported.body.data.ui_events[0].app_version).toBe("202608231530");
  });

  it("形の合わないビルドIDは、記録に混ぜずに落とす", async () => {
    const home = await createHousehold();

    await sendEvents(
      home.client,
      sessionId(),
      [{ seq: 0, t: Date.now(), screen: "home", type: "view", name: "enter" }],
      Date.now(),
      "ばーじょん",
    );

    const exported = await home.client.get("/api/export");
    expect(exported.body.data.ui_events[0].app_version).toBeNull();
  });

  /**
   * 子ども用の端末が2台あると device_kind だけでは見分けが付かず、
   * 「使われているのに記録が来ていない端末」を記録の側から見つけられなかった。
   */
  it("どの端末から来た記録かが残る", async () => {
    const home = await createHousehold();
    const child = home.children[0]!;

    const invite = await home.client.post("/api/devices/invites", {
      kind: "child",
      label: "はなのスマホ",
      memberId: child.id,
    });
    const device = new Client();
    await device.post(claimPath(invite.body.url));

    await sendEvents(device, sessionId(), [
      { seq: 0, t: Date.now(), screen: "ledger", type: "view", name: "enter", memberId: child.id },
    ]);

    const listed = await home.client.get("/api/devices");
    const registered = (listed.body as Array<{ id: string; label: string }>).find(
      (item) => item.label === "はなのスマホ",
    );

    const exported = await home.client.get("/api/export");
    expect(exported.body.data.ui_events[0].device_id).toBe(registered?.id);
    expect(exported.body.data.ui_events[0].device_kind).toBe("child");
  });
});

describe("テナントの分離", () => {
  it("他家庭の記録は1件も見えない", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();

    await sendEvents(victim.client, sessionId(), visit(victim.children[0]!.id));

    const report = await insights(attacker);
    expect(report.events).toBe(0);
    expect(report.sessions).toBe(0);
    expect(report.members).toEqual([]);
  });

  /**
   * 他家庭のメンバーIDを混ぜても、外部キー違反で落ちたり、
   * 見知らぬIDが集計に並んだりしない。
   */
  it("他家庭のメンバーIDは、誰のものでもない記録として入る", async () => {
    const victim = await createHousehold();
    const attacker = await createHousehold();

    const result = await sendEvents(attacker.client, sessionId(), [
      {
        seq: 0,
        t: Date.now(),
        screen: "ledger",
        type: "action",
        name: "stick",
        memberId: victim.children[0]!.id,
      },
    ]);

    expect(result.status).toBe(204);
    const report = await insights(attacker);
    expect(report.events).toBe(1);
    expect(report.members).toEqual([]);
    // 被害者側から見ても、他家庭が付けた記録は存在しない
    expect((await insights(victim)).events).toBe(0);
  });

  it("集計は親の操作。子ども用の端末からは見えない", async () => {
    const home = await createHousehold();
    const child = home.children[0]!;

    const invite = await home.client.post("/api/devices/invites", {
      kind: "child",
      label: "はなのスマホ",
      memberId: child.id,
    });
    const device = new Client();
    await device.post(claimPath(invite.body.url));

    // 記録は送れる(送り手はむしろ子の端末)
    expect((await sendEvents(device, sessionId(), visit(child.id))).status).toBe(204);
    // 見るのは親だけ
    const seen = await device.get("/api/insights?days=30");
    expect(seen.status).toBe(401);
    expect(seen.body.error).toBe("pin_required");
  });
});

describe("記録のあつかい", () => {
  it("記録しない設定にすると、送っても残らない", async () => {
    const home = await createHousehold();

    expect((await home.client.patch("/api/settings", { uiLogDays: 0 })).status).toBe(200);
    expect((await sendEvents(home.client, sessionId(), visit(home.children[0]!.id))).status).toBe(
      204,
    );

    const report = await insights(home);
    expect(report.events).toBe(0);
    expect(report.retentionDays).toBe(0);
  });

  it("消すと、集計も空になる", async () => {
    const home = await createHousehold();
    await sendEvents(home.client, sessionId(), visit(home.children[0]!.id));
    expect((await insights(home)).events).toBe(6);

    const cleared = await home.client.del("/api/ui-events");
    expect(cleared.status).toBe(200);
    expect(cleared.body.deleted).toBe(6);
    expect((await insights(home)).events).toBe(0);
  });

  it("持ち出し(export)にも操作記録が入る", async () => {
    const home = await createHousehold();
    await sendEvents(home.client, sessionId(), visit(home.children[0]!.id));

    const exported = await home.client.get("/api/export");
    expect(exported.status).toBe(200);
    expect(exported.body.data.ui_events).toHaveLength(6);
  });

  /**
   * 記録があるだけでメンバーを完全削除できなくなると、
   * 「間違えて追加した人を消す」という逃げ道が塞がってしまう。
   */
  it("操作記録しか無いメンバーは、完全に削除できる", async () => {
    const home = await createHousehold();
    const added = await home.client.post("/api/members", { name: "まちがい", role: "child" });
    expect(added.status).toBe(201);

    await sendEvents(home.client, sessionId(), [
      { seq: 0, t: Date.now(), screen: "ledger", type: "view", name: "enter", memberId: added.body.id },
    ]);

    const removed = await home.client.del(`/api/members/${added.body.id}?purge=1`);
    expect(removed.status).toBe(200);
    expect(removed.body.purged).toBe(true);

    // 記録は残るが、誰のものでもなくなる
    const report = await insights(home);
    expect(report.events).toBe(1);
    expect(report.members).toEqual([]);
  });
});
