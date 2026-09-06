import { describe, expect, it } from "vitest";
import { bonusMessage, deliveryOutcome, familiesToNotify } from "../../src/worker/lib/notify";

/**
 * 通知の文言と、朝の送信対象の絞り込み。
 * どちらも DB を触らない。実際の配信はライブラリに任せる。
 */

describe("bonusMessage", () => {
  it("子ども向けのひらがな文言になっている", () => {
    const message = bonusMessage(2, "2026-09-05");
    expect(message.title).toBe("きょうは ポイント2ばい デー！");
    expect(message.body).toContain("2まい");
    expect(message.icon).toBe("/icons/icon-192.png");
  });

  it("同じ日の通知が重ならないよう、日付をタグに入れる", () => {
    expect(bonusMessage(2, "2026-09-05").tag).toBe("bonus-2026-09-05");
    expect(bonusMessage(2, "2026-09-06").tag).toBe("bonus-2026-09-06");
  });
});

describe("familiesToNotify", () => {
  const rows = [
    { familyId: "fam_jst", timeZone: "Asia/Tokyo" },
    { familyId: "fam_utc", timeZone: "UTC" },
  ];

  it("ローカル時刻が8時の家庭だけを返す", () => {
    // 2026-09-05 23:00 UTC = 2026-09-06 08:00 JST
    expect(familiesToNotify(rows, Date.UTC(2026, 8, 5, 23, 0))).toEqual(["fam_jst"]);
    // 2026-09-06 08:00 UTC = 2026-09-06 17:00 JST
    expect(familiesToNotify(rows, Date.UTC(2026, 8, 6, 8, 0))).toEqual(["fam_utc"]);
  });

  it("どこも8時でなければ空", () => {
    expect(familiesToNotify(rows, Date.UTC(2026, 8, 5, 20, 0))).toEqual([]);
  });
});

/**
 * D1 を伴う notifyBonus の end-to-end はフェイクの D1Database が要って割に合わないので、
 * 実際の送信ステータスをどう扱うかの判断だけをここで固定しておく。
 * 特にリダイレクト(3xx)は配達できていないので sent 扱いにしないことが肝心。
 */
describe("deliveryOutcome", () => {
  it("2xx は sent", () => {
    expect(deliveryOutcome(200)).toBe("sent");
    expect(deliveryOutcome(201)).toBe("sent");
    expect(deliveryOutcome(204)).toBe("sent");
  });

  it("404 と 410 は revoke（購読が失効している）", () => {
    expect(deliveryOutcome(404)).toBe("revoke");
    expect(deliveryOutcome(410)).toBe("revoke");
  });

  it("それ以外の 4xx / 5xx は failed", () => {
    expect(deliveryOutcome(400)).toBe("failed");
    expect(deliveryOutcome(429)).toBe("failed");
    expect(deliveryOutcome(500)).toBe("failed");
    expect(deliveryOutcome(503)).toBe("failed");
  });

  it("3xx（リダイレクト）は配達できていないので failed", () => {
    expect(deliveryOutcome(301)).toBe("failed");
    expect(deliveryOutcome(302)).toBe("failed");
  });
});
