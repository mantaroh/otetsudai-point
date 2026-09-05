import { describe, expect, it } from "vitest";
import type { Sheet } from "../../src/shared/types";
import { createHousehold, stick, uuid } from "./client";

/**
 * 同時実行。
 *
 * 付与処理は楽観ロックを持たず、スキーマの部分ユニークインデックスに競合の検出を任せている
 * (stickers_slot / sheets_one_active / sheets_member_seq)。
 * batch が落ちたら読み直して再試行する、という設計が本当に成り立っているかをここで裏付ける。
 *
 * 家庭内利用でここまでの同時実行は起きないが、成り立たなくなったときに
 * 「シールが消える」「同じマスが二重に埋まる」という最悪の壊れ方をするので、押さえておく。
 */

async function allSheets(
  home: Awaited<ReturnType<typeof createHousehold>>,
  memberId: string,
): Promise<Sheet[]> {
  const boot = (await home.client.get("/api/bootstrap")).body;
  const shelf = (await home.client.get(`/api/members/${memberId}/sheets`)).body as Sheet[];
  const open: Sheet[] = [
    ...(boot.sheets[memberId] ? [boot.sheets[memberId]] : []),
    ...boot.pendingSheets.filter((sheet: Sheet) => sheet.memberId === memberId),
  ];
  // ちょうど満了した台帳は current と pending の両方に出るので、ID で重複を除く
  const byId = new Map<string, Sheet>();
  for (const sheet of [...shelf, ...open]) byId.set(sheet.id, sheet);
  return [...byId.values()].sort((a, b) => a.seqNo - b.seqNo);
}

function totalStickers(sheets: Sheet[]): number {
  return sheets.reduce((sum, sheet) => sum + sheet.stickers.length, 0);
}

function hasDuplicatePositions(sheets: Sheet[]): boolean {
  return sheets.some((sheet) => {
    const positions = sheet.stickers.map((sticker) => sticker.position);
    return new Set(positions).size !== positions.length;
  });
}

describe("同時にシールを貼る", () => {
  it("並行に貼っても、1枚も失われず二重にもならない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const child = home.children[0]!;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => stick(home.client, child.id, home.choreId, 1)),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);

    const sheets = await allSheets(home, child.id);
    expect(totalStickers(sheets)).toBe(10);
    expect(hasDuplicatePositions(sheets)).toBe(false);
  });

  it("残り1マスを取り合っても、あふれた分が次の台帳に回る", async () => {
    const home = await createHousehold({ capacity: 5 });
    const child = home.children[0]!;
    await stick(home.client, child.id, home.choreId, 4);

    // 残り1マスに対して3枚が同時に飛んでくる
    const results = await Promise.all(
      Array.from({ length: 3 }, () => stick(home.client, child.id, home.choreId, 1)),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);

    const sheets = await allSheets(home, child.id);
    expect(totalStickers(sheets)).toBe(7);
    expect(hasDuplicatePositions(sheets)).toBe(false);

    // 1冊目はきっちり5枚で満了し、残り2枚が2冊目に乗っている
    expect(sheets[0]!.stickers).toHaveLength(5);
    expect(sheets[0]!.status).toBe("full");
    expect(sheets[1]!.stickers).toHaveLength(2);
    expect(sheets.map((sheet) => sheet.seqNo)).toEqual([1, 2]);
  });

  it("複数冊ぶんが同時に飛んできても、通し番号が重複しない", async () => {
    const home = await createHousehold({ capacity: 5 });
    const child = home.children[0]!;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => stick(home.client, child.id, home.choreId, 2)),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);

    const sheets = await allSheets(home, child.id);
    expect(totalStickers(sheets)).toBe(12);
    expect(hasDuplicatePositions(sheets)).toBe(false);

    const seqNos = sheets.map((sheet) => sheet.seqNo);
    expect(new Set(seqNos).size).toBe(seqNos.length);
    // 12枚 ÷ 5マス = 3冊(5 + 5 + 2)
    expect(sheets.filter((sheet) => sheet.stickers.length > 0)).toHaveLength(3);
  });

  it("きょうだいが同時に貼っても、お互いの台帳に混ざらない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const [hana, taro] = home.children;

    await Promise.all([
      ...Array.from({ length: 5 }, () => stick(home.client, hana!.id, home.choreId, 1)),
      ...Array.from({ length: 3 }, () => stick(home.client, taro!.id, home.choreId, 1)),
    ]);

    expect(totalStickers(await allSheets(home, hana!.id))).toBe(5);
    expect(totalStickers(await allSheets(home, taro!.id))).toBe(3);
  });

  it("同じ requestId が並行で飛んできても、1件しか成立しない", async () => {
    const home = await createHousehold({ capacity: 30 });
    const child = home.children[0]!;
    const requestId = uuid();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        home.client.post("/api/grants", {
          memberId: child.id,
          choreId: home.choreId,
          count: 1,
          requestId,
        }),
      ),
    );

    const grantIds = new Set(results.map((result) => result.body.grant.id));
    expect(grantIds.size).toBe(1);
    expect(totalStickers(await allSheets(home, child.id))).toBe(1);
  });

  it("貼るのと取り消すのが混ざっても、枚数の辻褄が合う", async () => {
    const home = await createHousehold({ capacity: 30 });
    const child = home.children[0]!;

    const first = await stick(home.client, child.id, home.choreId, 3);

    await Promise.all([
      stick(home.client, child.id, home.choreId, 2),
      home.client.post(`/api/grants/${first.body.grant.id}/revoke`, {}),
      stick(home.client, child.id, home.choreId, 1),
    ]);

    const sheets = await allSheets(home, child.id);
    expect(totalStickers(sheets)).toBe(3); // 3 - 3 + 2 + 1
    expect(hasDuplicatePositions(sheets)).toBe(false);
  });
});
