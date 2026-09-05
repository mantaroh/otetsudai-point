# ポイント2倍デー と おしらせ通知 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 親が「今日はポイント2倍」を単発・定期で切り替えられるようにし、その日に子どもへ Web Push で通知を出す。

**Architecture:** 単発も定期も `bonus_rules` テーブルの1行として持ち、シールを貼るたびに家庭のローカル日付で倍率を評価して `grants.count` に倍後の枚数を書く。通知は `push_subscriptions` に購読を貯め、親が ON した瞬間と毎時 Cron の2経路から `notify.ts` を呼ぶ。二重送信は `push_sends` の主キーで止める。

**Tech Stack:** Cloudflare Workers / Hono / D1 (SQLite) / React 19 / TanStack Query / Tailwind v4 / Vitest / Playwright

**Spec:** `docs/superpowers/specs/2026-09-05-bonus-multiplier-design.md`

## Global Constraints

- **時刻はすべて UNIX epoch ミリ秒の INTEGER。** 既存スキーマの方針に合わせる。
- **削除しない。** 無効化は `disabled_at` / `revoked_at` で表す。
- **`family_id` を全テーブルに持たせる。** `WHERE family_id = ?` が JOIN なしで書けること。
- **`familyId` は `getAuth(c).familyId` からしか取らない。** URL やボディの家庭IDは信用しない。
- **`grants.count` の意味は変えない。** 「実際に貼られたシールの枚数」＝倍したあとの値。
- **日付の境界は `family_settings.timezone`（既定 `Asia/Tokyo`）のローカル日付。**
- **朝の送信時刻は 8 時固定**（家庭のローカル時刻）。
- **倍率は 2 固定。** DB は 2〜10 を許すが UI からは選ばせない。
- **子ども向けの文言はひらがな中心。** 既存の `Ledger.tsx` / `Home.tsx` に合わせる。
- **コミットメッセージに AI / エージェント名を書かない。**
- **iOS / iPadOS の Web Push は 16.4 以降かつホーム画面追加の PWA のみ。** 非対応端末には通知ボタンを出さない。

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/worker/lib/day.ts` | 家庭のタイムゾーンでの日付・曜日・時。DB に触らない |
| `src/worker/db/bonus.ts` | `bonus_rules` の読み書きと倍率の評価 |
| `src/worker/routes/bonus.ts` | 2倍デーの API（親のみ） |
| `src/worker/db/push.ts` | `push_subscriptions` / `push_sends` の読み書き |
| `src/worker/lib/notify.ts` | 通知の文言・宛先の決定・送信。Cron と API の両方から呼ぶ |
| `src/worker/routes/push.ts` | 購読の登録・解除 |
| `src/client/lib/push.ts` | ブラウザ側の対応判定と購読 |
| `src/client/components/BonusBanner.tsx` | 2倍デーの帯 |

`multiplierFor` は純関数だが `db/bonus.ts` に置く。既存の `db/uiEvents.ts` が
純関数 `tzOffsetModifier` を同じ形で持っているので、それに合わせる。

---

### Task 1: 日付ユーティリティ

**Files:**
- Create: `src/worker/lib/day.ts`
- Test: `tests/unit/day.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `dayKey(at: number, timeZone: string): string` — `'2026-09-05'`
  - `weekdayOf(key: string): number` — 0(日)..6(土)
  - `dayOfMonthOf(key: string): number` — 1..31
  - `localHour(at: number, timeZone: string): number` — 0..23

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/day.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dayKey, dayOfMonthOf, localHour, weekdayOf } from "../../src/worker/lib/day";

/**
 * 2倍デーの判定は「家庭のローカル日付」で行う。
 * ここがずれると、23時台に貼ったシールが翌日扱いになる。
 */

const JST = "Asia/Tokyo";

describe("dayKey", () => {
  it("JST の 23:59 はその日のまま", () => {
    // 2026-09-05 23:59:59 JST = 2026-09-05 14:59:59 UTC
    expect(dayKey(Date.UTC(2026, 8, 5, 14, 59, 59), JST)).toBe("2026-09-05");
  });

  it("JST の 00:00 で日付が変わる", () => {
    // 2026-09-06 00:00:00 JST = 2026-09-05 15:00:00 UTC
    expect(dayKey(Date.UTC(2026, 8, 5, 15, 0, 0), JST)).toBe("2026-09-06");
  });

  it("タイムゾーンが違えば同じ瞬間でも日付が違う", () => {
    const at = Date.UTC(2026, 8, 5, 15, 0, 0);
    expect(dayKey(at, JST)).toBe("2026-09-06");
    expect(dayKey(at, "UTC")).toBe("2026-09-05");
  });
});

describe("weekdayOf", () => {
  it("2026-09-05 は土曜", () => {
    expect(weekdayOf("2026-09-05")).toBe(6);
  });

  it("2026-09-06 は日曜", () => {
    expect(weekdayOf("2026-09-06")).toBe(0);
  });
});

describe("dayOfMonthOf", () => {
  it("日を取り出す", () => {
    expect(dayOfMonthOf("2026-09-05")).toBe(5);
    expect(dayOfMonthOf("2026-09-30")).toBe(30);
  });
});

describe("localHour", () => {
  it("JST の朝8時を 8 として返す", () => {
    // 2026-09-06 08:00 JST = 2026-09-05 23:00 UTC
    expect(localHour(Date.UTC(2026, 8, 5, 23, 0, 0), JST)).toBe(8);
  });

  it("深夜0時は 24 ではなく 0", () => {
    expect(localHour(Date.UTC(2026, 8, 5, 15, 0, 0), JST)).toBe(0);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run --project unit tests/unit/day.test.ts`
Expected: FAIL（`Failed to resolve import ".../lib/day"`）

- [ ] **Step 3: 実装する**

`src/worker/lib/day.ts`:

```ts
/**
 * 家庭のタイムゾーンでの「日付」を扱う。
 *
 * 2倍デーの判定は絶対時刻ではなく日付で行う。
 * ローカル日付が変われば「今日だけ2倍」のルールは自然に外れるので、
 * 期限切れを掃除する仕組みが要らない。
 */

/** epoch ミリ秒 → 家庭のローカル日付 'YYYY-MM-DD' */
export function dayKey(at: number, timeZone: string): string {
  // en-CA は YYYY-MM-DD の順で返す。自前で組み立てるより取り違えが少ない。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** 'YYYY-MM-DD' → 曜日 0(日)..6(土) */
export function weekdayOf(key: string): number {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  // 日付文字列は既にローカル日付なので、ここでタイムゾーンを二度通さない
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 'YYYY-MM-DD' → 日 1..31 */
export function dayOfMonthOf(key: string): number {
  return Number(key.slice(8, 10));
}

/**
 * epoch ミリ秒 → 家庭のローカル時 0..23。
 *
 * hourCycle に h23 を明示する。hour12:false だけだと、環境によって
 * 深夜0時が "24" になることがある。
 */
export function localHour(at: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at)),
  );
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run --project unit tests/unit/day.test.ts`
Expected: PASS（11 tests）

- [ ] **Step 5: コミット**

```bash
git add src/worker/lib/day.ts tests/unit/day.test.ts
git commit -m "家庭のタイムゾーンで日付と時を求めるユーティリティを追加"
```

---

### Task 2: 倍率の評価（純関数）と型

**Files:**
- Create: `src/worker/db/bonus.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/unit/bonus.test.ts`

**Interfaces:**
- Consumes: `dayKey` / `weekdayOf` / `dayOfMonthOf`（Task 1）
- Produces:
  - `BonusRule` / `BonusRuleInput` / `BonusState`（`src/shared/types.ts`）
  - `multiplierFor(rules: BonusRule[], key: string): number`

- [ ] **Step 1: 型を足す**

`src/shared/types.ts` の末尾に追加:

```ts
// ── ポイント2倍デー ────────────────────────────

export type BonusKind = "once" | "weekly" | "monthly";

export interface BonusRule {
  id: string;
  kind: BonusKind;
  /** kind='once' のとき 'YYYY-MM-DD' */
  onDate: string | null;
  /** kind='weekly' のとき 0(日)..6(土) */
  weekday: number | null;
  /** kind='monthly' のとき 1..31 */
  dayOfMonth: number | null;
  multiplier: number;
  createdAt: number;
}

/** 定期ルールの追加リクエスト */
export type BonusRuleInput =
  | { kind: "weekly"; weekday: number }
  | { kind: "monthly"; dayOfMonth: number };

/** 今日が2倍かどうか。bootstrap にも載せる */
export interface BonusState {
  active: boolean;
  multiplier: number;
  /** 2倍になっている理由。'none' なら倍率なし */
  source: "none" | "once" | "weekly" | "monthly";
  /** 家庭のローカル日付 */
  dayKey: string;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/bonus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BonusRule } from "../../src/shared/types";
import { multiplierFor } from "../../src/worker/db/bonus";

function rule(overrides: Partial<BonusRule>): BonusRule {
  return {
    id: "bns_1",
    kind: "once",
    onDate: null,
    weekday: null,
    dayOfMonth: null,
    multiplier: 2,
    createdAt: 1,
    ...overrides,
  };
}

// 2026-09-05 は土曜、2026-09-06 は日曜

describe("multiplierFor", () => {
  it("ルールが無ければ1倍", () => {
    expect(multiplierFor([], "2026-09-05")).toBe(1);
  });

  it("その日の単発ルールが当たる", () => {
    const rules = [rule({ kind: "once", onDate: "2026-09-05" })];
    expect(multiplierFor(rules, "2026-09-05")).toBe(2);
    expect(multiplierFor(rules, "2026-09-06")).toBe(1);
  });

  it("毎週日曜のルールが日曜だけ当たる", () => {
    const rules = [rule({ kind: "weekly", weekday: 0 })];
    expect(multiplierFor(rules, "2026-09-06")).toBe(2);
    expect(multiplierFor(rules, "2026-09-05")).toBe(1);
  });

  it("毎月9日のルールが9日だけ当たる", () => {
    const rules = [rule({ kind: "monthly", dayOfMonth: 9 })];
    expect(multiplierFor(rules, "2026-09-09")).toBe(2);
    expect(multiplierFor(rules, "2026-09-10")).toBe(1);
  });

  it("毎月31日は、31日がない月には当たらない", () => {
    const rules = [rule({ kind: "monthly", dayOfMonth: 31 })];
    expect(multiplierFor(rules, "2026-10-31")).toBe(2);
    // 2026-09 は30日まで。月末に丸めない
    expect(multiplierFor(rules, "2026-09-30")).toBe(1);
  });

  it("複数当たったら大きいほうを採る", () => {
    const rules = [
      rule({ id: "bns_a", kind: "weekly", weekday: 6, multiplier: 2 }),
      rule({ id: "bns_b", kind: "once", onDate: "2026-09-05", multiplier: 3 }),
    ];
    expect(multiplierFor(rules, "2026-09-05")).toBe(3);
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run --project unit tests/unit/bonus.test.ts`
Expected: FAIL（`multiplierFor` が見つからない）

- [ ] **Step 4: 実装する**

`src/worker/db/bonus.ts`（この時点では純関数だけ。DB 関数は Task 3 で足す）:

```ts
import type { BonusRule } from "../../shared/types";
import { dayOfMonthOf, weekdayOf } from "../lib/day";

/**
 * ポイント2倍デー。
 *
 * 単発（今日だけ）も定期（毎週日曜・毎月9日）も bonus_rules の1行として持つ。
 * 「今日だけ2倍」は kind='once' の行を1つ入れることと同じ。
 *
 * 評価は DB を触らない純関数に切り出してある。曜日・月末の扱いは
 * 単体テストで固めておきたいところで、ここが一番間違えやすい。
 */

/** 該当するルールが無ければ 1。複数当たったら大きいほうを採る。 */
export function multiplierFor(rules: BonusRule[], key: string): number {
  const weekday = weekdayOf(key);
  const dayOfMonth = dayOfMonthOf(key);

  let best = 1;
  for (const rule of rules) {
    const hit =
      (rule.kind === "once" && rule.onDate === key) ||
      (rule.kind === "weekly" && rule.weekday === weekday) ||
      // 毎月31日は、31日がない月にはそもそも当たらない。月末に丸めない。
      (rule.kind === "monthly" && rule.dayOfMonth === dayOfMonth);
    if (hit && rule.multiplier > best) best = rule.multiplier;
  }
  return best;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run --project unit`
Expected: PASS（既存の allocate / config も含めて全部）

- [ ] **Step 6: コミット**

```bash
git add src/shared/types.ts src/worker/db/bonus.ts tests/unit/bonus.test.ts
git commit -m "ポイント2倍デーの倍率評価と型を追加"
```

---

### Task 3: マイグレーションとルールの読み書き

**Files:**
- Create: `migrations/0004_bonus.sql`
- Modify: `src/worker/db/bonus.ts`

**Interfaces:**
- Consumes: `multiplierFor`（Task 2）、`dayKey`（Task 1）、`getTimeZone`（`src/worker/db/family.ts:149`）
- Produces:
  - `listRules(db, familyId): Promise<BonusRule[]>`
  - `getState(db, familyId, at): Promise<BonusState>`
  - `resolveMultiplier(db, familyId, at): Promise<number>`
  - `enableToday(db, familyId, at, createdBy): Promise<BonusState>`
  - `disableToday(db, familyId, at): Promise<BonusState>`
  - `addRule(db, familyId, input: BonusRuleInput, createdBy): Promise<BonusRule>`
  - `removeRule(db, familyId, ruleId): Promise<void>`

- [ ] **Step 1: マイグレーションを書く**

`migrations/0004_bonus.sql`:

```sql
-- ポイント2倍デー。
--
-- 単発（今日だけ）も定期（毎週日曜・毎月9日）も、このテーブルの1行として持つ。
-- 削除はせず disabled_at で無効化する（既存テーブルの方針に合わせる）。

CREATE TABLE bonus_rules (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  kind         TEXT NOT NULL CHECK (kind IN ('once', 'weekly', 'monthly')),
  on_date      TEXT,     -- kind='once' のとき 'YYYY-MM-DD'(家庭のローカル日付)
  weekday      INTEGER,  -- kind='weekly' のとき 0(日)..6(土)
  day_of_month INTEGER,  -- kind='monthly' のとき 1..31
  multiplier   INTEGER NOT NULL DEFAULT 2 CHECK (multiplier BETWEEN 2 AND 10),
  created_by   TEXT REFERENCES members (id),
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER,
  CHECK (
    (kind = 'once'    AND on_date IS NOT NULL AND weekday IS NULL AND day_of_month IS NULL) OR
    (kind = 'weekly'  AND on_date IS NULL AND weekday BETWEEN 0 AND 6 AND day_of_month IS NULL) OR
    (kind = 'monthly' AND on_date IS NULL AND weekday IS NULL AND day_of_month BETWEEN 1 AND 31)
  )
);
CREATE INDEX bonus_rules_family ON bonus_rules (family_id, disabled_at);

-- 同じ内容のルールが二重に登録されないようにする(有効なものだけ)。
-- アプリ側の約束ではなく、スキーマ側の制約として持たせる。
CREATE UNIQUE INDEX bonus_rules_once
  ON bonus_rules (family_id, on_date)      WHERE kind = 'once'    AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_weekly
  ON bonus_rules (family_id, weekday)      WHERE kind = 'weekly'  AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_monthly
  ON bonus_rules (family_id, day_of_month) WHERE kind = 'monthly' AND disabled_at IS NULL;

-- 倍にする前の枚数と、適用した倍率。
-- count は今まで通り「実際に貼られたシールの枚数」＝倍したあとの値のまま。
ALTER TABLE grants ADD COLUMN base_count INTEGER;
ALTER TABLE grants ADD COLUMN multiplier INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: マイグレーションを流す**

```bash
npm run db:reset
```

Expected: エラーなく完了する（dev サーバは止めてから実行する）

- [ ] **Step 3: DB 関数を実装する**

`src/worker/db/bonus.ts` に追記（先頭の import を差し替え）:

```ts
import type { BonusRule, BonusRuleInput, BonusState } from "../../shared/types";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { dayKey, dayOfMonthOf, weekdayOf } from "../lib/day";
import { getTimeZone } from "./family";
```

（`multiplierFor` はそのまま。以下をファイル末尾に足す）

```ts
// ── 行の型とマッパ ─────────────────────────────

interface BonusRuleRow {
  id: string;
  kind: "once" | "weekly" | "monthly";
  on_date: string | null;
  weekday: number | null;
  day_of_month: number | null;
  multiplier: number;
  created_at: number;
}

const RULE_COLUMNS = `id, kind, on_date, weekday, day_of_month, multiplier, created_at`;

function toRule(row: BonusRuleRow): BonusRule {
  return {
    id: row.id,
    kind: row.kind,
    onDate: row.on_date,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    multiplier: row.multiplier,
    createdAt: row.created_at,
  };
}

// ── 読み取り ──────────────────────────────────

export async function listRules(db: D1Database, familyId: string): Promise<BonusRule[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM bonus_rules
        WHERE family_id = ? AND disabled_at IS NULL
        ORDER BY kind, weekday, day_of_month, on_date`,
    )
    .bind(familyId)
    .all<BonusRuleRow>();
  return results.map(toRule);
}

/** 今日の状態。理由（source）も返す。定期で2倍の日はトグルを押せなくするために使う。 */
export async function getState(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);
  const rules = await listRules(db, familyId);
  const multiplier = multiplierFor(rules, key);

  if (multiplier <= 1) {
    return { active: false, multiplier: 1, source: "none", dayKey: key };
  }

  // 単発があればそれを理由にする。取り消せるのは単発だけなので、そちらを優先して見せる。
  const weekday = weekdayOf(key);
  const dayOfMonth = dayOfMonthOf(key);
  const source = rules.some((rule) => rule.kind === "once" && rule.onDate === key)
    ? "once"
    : rules.some((rule) => rule.kind === "weekly" && rule.weekday === weekday)
      ? "weekly"
      : "monthly";

  return { active: true, multiplier, source, dayKey: key };
}

/** シールを貼るときの倍率。該当が無ければ 1。 */
export async function resolveMultiplier(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<number> {
  const timeZone = await getTimeZone(db, familyId);
  const rules = await listRules(db, familyId);
  return multiplierFor(rules, dayKey(at, timeZone));
}

// ── 書き込み ──────────────────────────────────

/** 今日を2倍にする。すでに2倍なら何もしない（同じ結果を返す）。 */
export async function enableToday(
  db: D1Database,
  familyId: string,
  at: number,
  createdBy: string | null,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);

  // 部分ユニークインデックスがあるので、二重に押されても1行しか入らない
  await db
    .prepare(
      `INSERT OR IGNORE INTO bonus_rules
         (id, family_id, kind, on_date, multiplier, created_by, created_at)
       VALUES (?, ?, 'once', ?, 2, ?, ?)`,
    )
    .bind(newId("bns"), familyId, key, createdBy, at)
    .run();

  return getState(db, familyId, at);
}

/**
 * 今日の単発ルールを無効化する。
 *
 * 定期ルールで2倍になっている日はここでは戻せない。
 * 戻したいときは定期ルールそのものを消す。
 */
export async function disableToday(
  db: D1Database,
  familyId: string,
  at: number,
): Promise<BonusState> {
  const timeZone = await getTimeZone(db, familyId);
  const key = dayKey(at, timeZone);

  await db
    .prepare(
      `UPDATE bonus_rules SET disabled_at = ?
        WHERE family_id = ? AND kind = 'once' AND on_date = ? AND disabled_at IS NULL`,
    )
    .bind(at, familyId, key)
    .run();

  return getState(db, familyId, at);
}

export async function addRule(
  db: D1Database,
  familyId: string,
  input: BonusRuleInput,
  createdBy: string | null,
): Promise<BonusRule> {
  const id = newId("bns");
  const now = Date.now();
  const weekday = input.kind === "weekly" ? input.weekday : null;
  const dayOfMonth = input.kind === "monthly" ? input.dayOfMonth : null;

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO bonus_rules
         (id, family_id, kind, weekday, day_of_month, multiplier, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 2, ?, ?)`,
    )
    .bind(id, familyId, input.kind, weekday, dayOfMonth, createdBy, now)
    .run();

  // IGNORE された = 同じ設定が既にある
  if (result.meta.changes === 0) throw conflict("同じ設定がすでにあります");

  return {
    id,
    kind: input.kind,
    onDate: null,
    weekday,
    dayOfMonth,
    multiplier: 2,
    createdAt: now,
  };
}

export async function removeRule(
  db: D1Database,
  familyId: string,
  ruleId: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE bonus_rules SET disabled_at = ?
        WHERE family_id = ? AND id = ? AND disabled_at IS NULL`,
    )
    .bind(Date.now(), familyId, ruleId)
    .run();
  if (result.meta.changes === 0) throw notFound("その設定は見つかりませんでした");
}
```

- [ ] **Step 4: 型チェックが通ることを確認する**

Run: `npm run build`
Expected: 成功（`tsc -b` がエラーを出さない）

- [ ] **Step 5: コミット**

```bash
git add migrations/0004_bonus.sql src/worker/db/bonus.ts
git commit -m "bonus_rules テーブルとルールの読み書きを追加"
```

---

### Task 4: 2倍デーの API

**Files:**
- Create: `src/worker/routes/bonus.ts`
- Modify: `src/worker/index.ts`
- Test: `tests/api/bonus.test.ts`

**Interfaces:**
- Consumes: Task 3 の DB 関数、`requireParent` / `getAuth`（`src/worker/auth/middleware.ts`）、`resolveParentMemberId`（`src/worker/db/family.ts`）
- Produces: `bonusRoutes`（Hono ルータ）。エンドポイントは下表

| メソッド | パス | 返り |
|---|---|---|
| GET | `/api/bonus` | `{ state: BonusState, rules: BonusRule[] }` |
| POST | `/api/bonus/today` | `{ state: BonusState, notified: boolean }` |
| DELETE | `/api/bonus/today` | `{ state: BonusState }` |
| POST | `/api/bonus/rules` | `{ rule: BonusRule }`（201） |
| DELETE | `/api/bonus/rules/:ruleId` | `{ ok: true }` |

> `notified` は Task 9 で通知を繋いだあと意味を持つ。この Task では常に `false` を返す。

- [ ] **Step 1: 失敗するテストを書く**

`tests/api/bonus.test.ts`:

```ts
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run --project api tests/api/bonus.test.ts`
Expected: FAIL（`/api/bonus` が 404）

- [ ] **Step 3: ルータを実装する**

`src/worker/routes/bonus.ts`:

```ts
import { Hono } from "hono";
import type { BonusRuleInput } from "../../shared/types";
import { badRequest } from "../lib/errors";
import { asInt, asString, readJson } from "../lib/validate";
import { resolveParentMemberId } from "../db/family";
import {
  addRule,
  disableToday,
  enableToday,
  getState,
  listRules,
  removeRule,
} from "../db/bonus";
import { getAuth, requireParent } from "../auth/middleware";
import type { AppBindings } from "../types";

/**
 * ポイント2倍デー。設定できるのは親だけ。
 * 今日が2倍かどうかの読み取りは bootstrap から返すので、ここは親向けの設定 API に絞る。
 */
export const bonusRoutes = new Hono<AppBindings>();

bonusRoutes.get("/bonus", requireParent, async (c) => {
  const auth = getAuth(c);
  const [state, rules] = await Promise.all([
    getState(c.env.DB, auth.familyId, Date.now()),
    listRules(c.env.DB, auth.familyId),
  ]);
  return c.json({ state, rules });
});

bonusRoutes.post("/bonus/today", requireParent, async (c) => {
  const auth = getAuth(c);
  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  const state = await enableToday(c.env.DB, auth.familyId, Date.now(), parentMemberId);
  // 通知は Task 9 で繋ぐ
  return c.json({ state, notified: false });
});

bonusRoutes.delete("/bonus/today", requireParent, async (c) => {
  const auth = getAuth(c);
  const state = await disableToday(c.env.DB, auth.familyId, Date.now());
  return c.json({ state });
});

bonusRoutes.post("/bonus/rules", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ kind?: unknown; weekday?: unknown; dayOfMonth?: unknown }>(
    c.req.raw,
  );
  const kind = asString(body.kind, "kind", { max: 16 });

  let input: BonusRuleInput;
  if (kind === "weekly") {
    input = { kind, weekday: asInt(body.weekday, "曜日", { min: 0, max: 6 }) };
  } else if (kind === "monthly") {
    input = { kind, dayOfMonth: asInt(body.dayOfMonth, "日にち", { min: 1, max: 31 }) };
  } else {
    throw badRequest("毎週か毎月かを選んでください");
  }

  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  const rule = await addRule(c.env.DB, auth.familyId, input, parentMemberId);
  return c.json({ rule }, 201);
});

bonusRoutes.delete("/bonus/rules/:ruleId", requireParent, async (c) => {
  const auth = getAuth(c);
  await removeRule(c.env.DB, auth.familyId, asString(c.req.param("ruleId"), "ruleId", { max: 64 }));
  return c.json({ ok: true });
});
```

- [ ] **Step 4: ルータを登録する**

`src/worker/index.ts` の import に足す:

```ts
import { bonusRoutes } from "./routes/bonus";
```

`api.route("/", insightsRoutes);` の次の行に足す:

```ts
api.route("/", bonusRoutes);
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run --project api tests/api/bonus.test.ts`
Expected: PASS（10 tests）

- [ ] **Step 6: コミット**

```bash
git add src/worker/routes/bonus.ts src/worker/index.ts tests/api/bonus.test.ts
git commit -m "ポイント2倍デーの設定 API を追加"
```

---

### Task 5: 付与に倍率を適用する

**Files:**
- Modify: `src/worker/db/ledger.ts`
- Modify: `src/worker/routes/ledger.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/api/bonus.test.ts`（追記）

**Interfaces:**
- Consumes: `resolveMultiplier` / `getState`（Task 3）
- Produces:
  - `Grant` に `baseCount: number` / `multiplier: number`
  - `BootstrapResponse` に `bonusToday: BonusState`
  - `CreateGrantInput` に `baseCount: number` / `multiplier: number`

- [ ] **Step 1: 失敗するテストを書く**

`tests/api/bonus.test.ts` の末尾に追記:

```ts
import { currentSheet, stick } from "./client";

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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run --project api tests/api/bonus.test.ts`
Expected: FAIL（`count` が 3 のまま、`bonusToday` が undefined）

- [ ] **Step 3: 型を広げる**

`src/shared/types.ts` の `Grant` に2つ足す:

```ts
  /** 倍にする前の枚数（子が押した回数） */
  baseCount: number;
  /** 適用した倍率。ふだんは 1 */
  multiplier: number;
```

`BootstrapResponse` に足す:

```ts
  bonusToday: BonusState;
```

- [ ] **Step 4: ledger.ts に倍率を通す**

`src/worker/db/ledger.ts` の変更点は4つ。

`GrantRow` に足す:

```ts
  base_count: number | null;
  multiplier: number;
```

`GRANT_COLUMNS` を差し替える:

```ts
const GRANT_COLUMNS = `g.id, g.member_id, g.chore_id, g.chore_label, g.chore_emoji, g.count,
                       g.base_count, g.multiplier,
                       g.note, g.created_by, m.name AS created_by_name, g.created_via,
                       g.created_at, g.approved_at, g.revoked_at, g.revoke_reason`;
```

`toGrant` に足す（`count: row.count,` の直後）:

```ts
    // この列より前に作られた grant は base_count を持たない
    baseCount: row.base_count ?? row.count,
    multiplier: row.multiplier,
```

`CreateGrantInput` に足す:

```ts
  /** 倍にする前の枚数 */
  baseCount: number;
  /** 適用する倍率。count は既に倍したあとの値であること */
  multiplier: number;
```

`attemptCreateGrant` の INSERT を差し替える:

```ts
    db
      .prepare(
        `INSERT INTO grants (id, family_id, member_id, chore_id, chore_label, chore_emoji, count,
                             base_count, multiplier,
                             note, created_by, created_via, request_id, created_at, approved_at, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        grantId,
        familyId,
        input.memberId,
        input.choreId,
        input.choreLabel,
        input.choreEmoji,
        input.count,
        input.baseCount,
        input.multiplier,
        input.note,
        input.createdBy,
        input.createdVia,
        input.requestId,
        now,
        approvedAt,
        approvedAt ? input.createdBy : null,
      ),
```

- [ ] **Step 5: routes/ledger.ts で倍率を解決する**

import に足す:

```ts
import { getState, resolveMultiplier } from "../db/bonus";
```

`POST /grants` の枚数まわりを差し替える（現在の `const count = asInt(...)` の行）:

```ts
  // 押した回数はそのまま base_count に残し、count には倍したあとの枚数を入れる。
  // count の意味（実際に貼られたシールの枚数）は変えないので、配る処理は無変更で済む。
  const baseCount = asInt(body.count, "枚数", { min: 1, max: 50 });
  const multiplier = await resolveMultiplier(c.env.DB, auth.familyId, Date.now());
  const count = baseCount * multiplier;
```

`createGrant(...)` の呼び出しに足す:

```ts
    baseCount,
    multiplier,
```

`GET /bootstrap` の `Promise.all` に足す（`listPendingGrants(...)` の次）:

```ts
    getState(c.env.DB, auth.familyId, Date.now()),
```

分割代入を差し替える:

```ts
  const [family, settings, members, chores, open, pendingGrants, bonusToday] = await Promise.all([
```

`const response: BootstrapResponse = {` に足す:

```ts
    bonusToday,
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx vitest run --project api`
Expected: PASS（既存の ledger / approval / concurrency も含めて全部）

- [ ] **Step 7: コミット**

```bash
git add src/shared/types.ts src/worker/db/ledger.ts src/worker/routes/ledger.ts tests/api/bonus.test.ts
git commit -m "2倍デーの日はシールを倍の枚数で発行する"
```

---

### Task 6: 親設定のボーナス欄

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/screens/ParentSettings.tsx`
- Test: `tests/dom/Bonus.test.tsx`

**Interfaces:**
- Consumes: Task 4 の API
- Produces:
  - `api.bonus()` / `api.enableBonusToday()` / `api.disableBonusToday()` / `api.addBonusRule()` / `api.removeBonusRule()`
  - `BonusSection`（`ParentSettings.tsx` 内の非公開コンポーネント）

- [ ] **Step 1: API クライアントに足す**

`src/client/api.ts` の import に型を足す:

```ts
  BonusRule,
  BonusRuleInput,
  BonusState,
```

`api` オブジェクトに足す（`updateSettings` の隣）。
このファイルには `request` と `post` しかヘルパーが無いので、GET と DELETE は
`request` を直接使う（`api.exportData` / `api.clearUiLog` と同じ書き方）:

```ts
  bonus: (pin?: string) =>
    request<{ state: BonusState; rules: BonusRule[] }>("bonus", "/bonus", { pin }),

  enableBonusToday: (pin?: string) =>
    post<{ state: BonusState; notified: boolean }>("bonus-today-on", "/bonus/today", undefined, pin),

  disableBonusToday: (pin?: string) =>
    request<{ state: BonusState }>("bonus-today-off", "/bonus/today", { method: "DELETE", pin }),

  addBonusRule: (input: BonusRuleInput, pin?: string) =>
    post<{ rule: BonusRule }>("bonus-rule-add", "/bonus/rules", input, pin),

  removeBonusRule: (ruleId: string, pin?: string) =>
    request<{ ok: true }>("bonus-rule-remove", `/bonus/rules/${ruleId}`, {
      method: "DELETE",
      pin,
    }),
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/dom/Bonus.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BonusRule, BonusState } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      bonus: vi.fn(),
      enableBonusToday: vi.fn(),
      disableBonusToday: vi.fn(),
      addBonusRule: vi.fn(),
      removeBonusRule: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api } from "../../src/client/api";
import { SettingsTab } from "../../src/client/screens/ParentSettings";
import { makeBootstrap, renderScreen } from "./helpers";

const OFF: BonusState = { active: false, multiplier: 1, source: "none", dayKey: "2026-09-05" };
const ON_ONCE: BonusState = { active: true, multiplier: 2, source: "once", dayKey: "2026-09-05" };
const ON_WEEKLY: BonusState = { active: true, multiplier: 2, source: "weekly", dayKey: "2026-09-06" };

const SUNDAY_RULE: BonusRule = {
  id: "bns_sun",
  kind: "weekly",
  onDate: null,
  weekday: 0,
  dayOfMonth: null,
  multiplier: 2,
  createdAt: 1,
};

beforeEach(() => {
  vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());
  vi.mocked(api.bonus).mockResolvedValue({ state: OFF, rules: [] });
  vi.mocked(api.enableBonusToday).mockResolvedValue({ state: ON_ONCE, notified: true });
  vi.mocked(api.disableBonusToday).mockResolvedValue({ state: OFF });
  vi.mocked(api.addBonusRule).mockResolvedValue({ rule: SUNDAY_RULE });
  vi.mocked(api.removeBonusRule).mockResolvedValue({ ok: true });
});

describe("ポイント2倍デーの設定", () => {
  it("今日を2倍にできる", async () => {
    renderScreen(<SettingsTab />);
    const button = await screen.findByRole("button", { name: /今日をポイント2倍にする/ });

    await userEvent.click(button);

    await waitFor(() => expect(api.enableBonusToday).toHaveBeenCalled());
    expect(await screen.findByText(/今日はポイント2倍/)).toBeInTheDocument();
  });

  it("定期ルールで2倍の日は、理由を出して押せなくする", async () => {
    vi.mocked(api.bonus).mockResolvedValue({ state: ON_WEEKLY, rules: [SUNDAY_RULE] });
    renderScreen(<SettingsTab />);

    expect(await screen.findByText(/毎週日曜日の設定で2倍/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /今日の2倍をやめる/ })).toBeNull();
  });

  it("毎週の曜日を追加できる", async () => {
    renderScreen(<SettingsTab />);
    const sunday = await screen.findByRole("button", { name: "毎週 日曜日" });

    await userEvent.click(sunday);

    await waitFor(() =>
      expect(api.addBonusRule).toHaveBeenCalledWith({ kind: "weekly", weekday: 0 }, undefined),
    );
  });

  it("毎月の日にちを追加できる", async () => {
    renderScreen(<SettingsTab />);
    const input = await screen.findByLabelText("毎月の日にち");

    await userEvent.type(input, "9");
    await userEvent.click(screen.getByRole("button", { name: "毎月の日を追加" }));

    await waitFor(() =>
      expect(api.addBonusRule).toHaveBeenCalledWith({ kind: "monthly", dayOfMonth: 9 }, undefined),
    );
  });

  it("登録ずみのルールを消せる", async () => {
    vi.mocked(api.bonus).mockResolvedValue({ state: OFF, rules: [SUNDAY_RULE] });
    renderScreen(<SettingsTab />);

    await userEvent.click(await screen.findByRole("button", { name: "毎週日曜日 を削除" }));

    await waitFor(() => expect(api.removeBonusRule).toHaveBeenCalledWith("bns_sun", undefined));
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run --project dom tests/dom/Bonus.test.tsx`
Expected: FAIL（ボタンが見つからない）

- [ ] **Step 4: `BonusSection` を実装する**

`src/client/screens/ParentSettings.tsx` の `SettingsTab` の中、`RulesSection` の次に
`<BonusSection />` を差し込み、`RulesSection` の定義の直後に以下を足す:

```tsx
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const SOURCE_LABEL: Record<string, string> = {
  weekly: "毎週の設定",
  monthly: "毎月の設定",
};

/**
 * ポイント2倍デー。
 *
 * 単発（今日だけ）と定期（毎週・毎月）を1か所で扱う。
 * 定期の設定で2倍になっている日は、単発の取り消しでは戻せないので、
 * トグルを出さずに理由だけを見せる。
 */
function BonusSection() {
  const { withPin } = usePin();
  const query = useQuery({ queryKey: ["bonus"], queryFn: () => api.bonus() });
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [busy, setBusy] = useState(false);

  const state = query.data?.state;
  const rules = query.data?.rules ?? [];

  async function run(action: (pin?: string) => Promise<unknown>) {
    setBusy(true);
    try {
      await withPin(action);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }

  const weekly = new Map(rules.filter((rule) => rule.kind === "weekly").map((r) => [r.weekday, r]));
  const monthly = rules.filter((rule) => rule.kind === "monthly");

  return (
    <Section title="ポイント2倍デー" hint="お手伝い1回で、シールが2まい貼られます">
      {state?.active ? (
        <p className="font-bold text-ink">今日はポイント2倍です</p>
      ) : (
        <p className="text-ink-soft">今日はふつうの1倍です</p>
      )}

      {state?.active && state.source !== "once" ? (
        <p className="text-sm text-ink-soft">
          {state.source === "weekly"
            ? `毎週${WEEKDAYS[new Date(`${state.dayKey}T00:00:00Z`).getUTCDay()]}曜日の設定で2倍になっています`
            : "毎月の設定で2倍になっています"}
          。やめるときは下の設定を消してください。
        </p>
      ) : state?.active ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run((pin) => api.disableBonusToday(pin))}
        >
          今日の2倍をやめる
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run((pin) => api.enableBonusToday(pin))}
        >
          今日をポイント2倍にする
        </button>
      )}

      <h3 className="mt-4 font-bold">毎週きまった曜日</h3>
      <div className="flex flex-wrap gap-2">
        {WEEKDAYS.map((label, weekday) => {
          const rule = weekly.get(weekday);
          return (
            <button
              key={weekday}
              type="button"
              disabled={busy}
              aria-pressed={rule !== undefined}
              className={rule ? "chip chip-on" : "chip"}
              onClick={() =>
                run((pin) =>
                  rule
                    ? api.removeBonusRule(rule.id, pin)
                    : api.addBonusRule({ kind: "weekly", weekday }, pin),
                )
              }
            >
              {rule ? `毎週${label}曜日 を削除` : `毎週 ${label}曜日`}
            </button>
          );
        })}
      </div>

      <h3 className="mt-4 font-bold">毎月きまった日</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-soft" htmlFor="bonus-day-of-month">
          毎月の日にち
        </label>
        <input
          id="bonus-day-of-month"
          className="input w-20"
          inputMode="numeric"
          value={dayOfMonth}
          onChange={(event) => setDayOfMonth(event.target.value.replace(/\D/g, "").slice(0, 2))}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || dayOfMonth === "" || Number(dayOfMonth) < 1 || Number(dayOfMonth) > 31}
          onClick={() =>
            run(async (pin) => {
              await api.addBonusRule({ kind: "monthly", dayOfMonth: Number(dayOfMonth) }, pin);
              setDayOfMonth("");
            })
          }
        >
          毎月の日を追加
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {monthly.map((rule) => (
          <li key={rule.id} className="flex items-center justify-between">
            <span>毎月 {rule.dayOfMonth}日</span>
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => run((pin) => api.removeBonusRule(rule.id, pin))}
            >
              毎月{rule.dayOfMonth}日 を削除
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-soft">
        31日を選ぶと、31日がない月はお休みになります。
      </p>
    </Section>
  );
}
```

> `className` の `btn` / `chip` / `input` は、同じファイルの他のセクションで使われている
> 実際のクラス名に合わせる。無ければ既存のボタンからコピーする。

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run --project dom tests/dom/Bonus.test.tsx`
Expected: PASS（5 tests）

- [ ] **Step 6: コミット**

```bash
git add src/client/api.ts src/client/screens/ParentSettings.tsx tests/dom/Bonus.test.tsx
git commit -m "親設定にポイント2倍デーの欄を追加"
```

---

### Task 7: 子ども画面のバナー

**Files:**
- Create: `src/client/components/BonusBanner.tsx`
- Modify: `src/client/screens/Ledger.tsx`
- Modify: `src/client/screens/Home.tsx`
- Modify: `tests/dom/helpers.tsx`
- Test: `tests/dom/BonusBanner.test.tsx`

**Interfaces:**
- Consumes: `BootstrapResponse.bonusToday`（Task 5）
- Produces: `BonusBanner({ onStart }: { onStart?: () => void })`

- [ ] **Step 1: フィクスチャに `bonusToday` を足す**

`tests/dom/helpers.tsx` の `makeBootstrap` の返り値に足す（`pendingGrants: [],` の隣）:

```ts
    bonusToday: { active: false, multiplier: 1, source: "none", dayKey: "2026-09-05" },
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/dom/BonusBanner.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BonusState } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return { ...actual, api: { bootstrap: vi.fn() } };
});

import { api } from "../../src/client/api";
import { BonusBanner } from "../../src/client/components/BonusBanner";
import { makeBootstrap, renderScreen } from "./helpers";

const ON: BonusState = { active: true, multiplier: 2, source: "once", dayKey: "2026-09-05" };

beforeEach(() => {
  vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());
});

describe("2倍デーのバナー", () => {
  it("ふだんの日は出ない", async () => {
    renderScreen(<BonusBanner />);
    // bootstrap の解決を待ってから、出ていないことを確かめる
    expect(await screen.findByTestId("bonus-banner-slot")).toBeEmptyDOMElement();
  });

  it("2倍の日は帯が出る", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    renderScreen(<BonusBanner />);

    expect(await screen.findByText("きょうは ポイント2ばい デー！")).toBeInTheDocument();
    expect(screen.getByText(/シールが 2まい/)).toBeInTheDocument();
  });

  it("「いま おてつだいする」で呼び出し元に知らせる", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    const onStart = vi.fn();
    renderScreen(<BonusBanner onStart={onStart} />);

    await userEvent.click(await screen.findByRole("button", { name: "いま おてつだいする" }));

    expect(onStart).toHaveBeenCalled();
  });

  it("onStart が無ければボタンを出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "いま おてつだいする" })).toBeNull();
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run --project dom tests/dom/BonusBanner.test.tsx`
Expected: FAIL（`BonusBanner` が見つからない）

- [ ] **Step 4: 実装する**

`src/client/components/BonusBanner.tsx`:

```tsx
import { useEffect } from "react";
import { useBootstrap } from "../hooks";
import { track } from "../lib/telemetry";

/**
 * ポイント2倍デーの帯。
 *
 * 気づかせるだけで終わらせず、そのままお手伝いに進めるようにする。
 * 「見えているのに押されていない」が後から分かるよう、表示とタップを記録する。
 */
export function BonusBanner({ onStart }: { onStart?: () => void }) {
  const { data } = useBootstrap();
  const active = data?.bonusToday?.active === true;
  const multiplier = data?.bonusToday?.multiplier ?? 1;

  useEffect(() => {
    if (active) track("view", "bonus-banner");
  }, [active]);

  if (!active) return <div data-testid="bonus-banner-slot" />;

  return (
    <div
      data-testid="bonus-banner-slot"
      className="rounded-2xl bg-amber-100 p-4 text-center shadow-sm"
    >
      <p className="text-xl font-bold text-amber-800">きょうは ポイント2ばい デー！</p>
      <p className="mt-1 text-amber-900">
        おてつだいすると シールが {multiplier}まい もらえるよ
      </p>
      {onStart && (
        <button
          type="button"
          className="btn mt-3"
          onClick={() => {
            track("action", "bonus-banner:start");
            onStart();
          }}
        >
          いま おてつだいする
        </button>
      )}
    </div>
  );
}
```

> `track` の引数の形は `src/client/lib/telemetry.ts` の既存の呼び出しに合わせる。
> `Ledger.tsx:82` の `track("action", "stick", { ... })` が手本。

- [ ] **Step 5: 台帳に差し込む**

`src/client/screens/Ledger.tsx`:

```tsx
import { useRef } from "react";
import { BonusBanner } from "../components/BonusBanner";
```

お手伝い選択のまとまり（`onStick` を渡している一覧）を包む要素に `ref` を付ける:

```tsx
const choresRef = useRef<HTMLDivElement>(null);
```

台帳の中身の一番上に置く:

```tsx
<BonusBanner onStart={() => choresRef.current?.scrollIntoView({ behavior: "smooth" })} />
```

- [ ] **Step 6: ホームに差し込む**

`src/client/screens/Home.tsx` の一覧の一番上に置く。
台帳のパスは `/m/:memberId`（`Home.tsx:35` と同じ）:

```tsx
import { BonusBanner } from "../components/BonusBanner";
```

`navigate` は同じファイルで既に import されている。子が1人だけなら直行し、
複数いるときは選ばせたいのでボタンを出さない:

```tsx
<BonusBanner
  onStart={children.length === 1 ? () => navigate(`/m/${children[0]!.id}`) : undefined}
/>
```

> `children` は同じファイルで一覧を描いているメンバー配列。
> 変数名が違う場合はそちらに合わせる。

- [ ] **Step 7: テストが通ることを確認する**

Run: `npx vitest run --project dom`
Expected: PASS（既存の Ledger / Home も含めて全部）

- [ ] **Step 8: コミット**

```bash
git add src/client/components/BonusBanner.tsx src/client/screens/Ledger.tsx src/client/screens/Home.tsx tests/dom/helpers.tsx tests/dom/BonusBanner.test.tsx
git commit -m "2倍デーの帯を台帳とホームに出す"
```

---

### Task 8: 親の履歴に ×2 バッジ

**Files:**
- Modify: `src/client/screens/Parent.tsx`
- Modify: `tests/dom/helpers.tsx`
- Test: `tests/dom/Parent.test.tsx`（追記）

**Interfaces:**
- Consumes: `Grant.multiplier`（Task 5）
- Produces: なし（画面だけ）

- [ ] **Step 1: フィクスチャに足す**

`tests/dom/helpers.tsx` の `makeGrant` の返り値に足す（`count: 1,` の隣）:

```ts
    baseCount: 1,
    multiplier: 1,
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/dom/Parent.test.tsx` に追記:

```tsx
  it("2倍で貼られたシールにはバッジが出る", async () => {
    vi.mocked(api.history).mockResolvedValue([
      makeGrant({ id: "grt_bonus", count: 6, baseCount: 3, multiplier: 2 }),
    ]);
    renderScreen(<ParentScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "りれき" }));

    expect(await screen.findByText("6まい")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  it("ふつうの日はバッジが出ない", async () => {
    vi.mocked(api.history).mockResolvedValue([makeGrant({ count: 1 })]);
    renderScreen(<ParentScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "りれき" }));

    await screen.findByText("1まい");
    expect(screen.queryByText("×2")).toBeNull();
  });
```

> `ParentScreen` / `api.history` / タブのラベルは、同じファイルの既存テストの
> 書き方をそのまま使う。import も既存のものを流用する。

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run --project dom tests/dom/Parent.test.tsx`
Expected: FAIL（`×2` が見つからない）

- [ ] **Step 4: 実装する**

`src/client/screens/Parent.tsx` の履歴の行（`{grant.count}まい` を出している箇所、`Parent.tsx:400` 付近）を差し替える:

```tsx
{formatDateTime(grant.createdAt)} ・ {grant.count}まい
{grant.multiplier > 1 && <BonusBadge multiplier={grant.multiplier} />} ・{" "}
```

承認待ちの一覧（`Parent.tsx:204` 付近）も同じ形にする:

```tsx
{formatDateTime(grant.createdAt)} ・ {grant.count}まい
{grant.multiplier > 1 && <BonusBadge multiplier={grant.multiplier} />}
```

同じファイルの `Badge` の定義の隣に足す:

```tsx
/** 2倍デーに貼られたシールの印 */
function BonusBadge({ multiplier }: { multiplier: number }) {
  return (
    <span className="ml-1 rounded border border-amber-500 px-1 text-xs text-amber-700">
      ×{multiplier}
    </span>
  );
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run --project dom tests/dom/Parent.test.tsx`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/client/screens/Parent.tsx tests/dom/helpers.tsx tests/dom/Parent.test.tsx
git commit -m "履歴と承認待ちに2倍のバッジを出す"
```

---

### Task 9: 購読の保存

**Files:**
- Create: `migrations/0005_push.sql`
- Create: `src/worker/db/push.ts`
- Create: `src/worker/routes/push.ts`
- Modify: `src/worker/index.ts`
- Test: `tests/api/push.test.ts`

**Interfaces:**
- Consumes: `getAuth`（`src/worker/auth/middleware.ts`）、`newId`
- Produces:
  - `StoredSubscription { id, endpoint, p256dh, auth }`
  - `saveSubscription(db, familyId, input): Promise<void>`
  - `removeSubscription(db, familyId, endpoint): Promise<boolean>`（消せたら true）
  - `listSubscriptions(db, familyId): Promise<StoredSubscription[]>`
  - `markSent(db, id, at): Promise<void>`
  - `markFailed(db, id): Promise<void>`
  - `revokeSubscription(db, id): Promise<void>`
  - `claimSend(db, familyId, dayKey, kind, at): Promise<boolean>`
  - `pushRoutes`

- [ ] **Step 1: マイグレーションを書く**

`migrations/0005_push.sql`:

```sql
-- Web Push の購読。
--
-- 端末ごとに1つ。endpoint が購読の identity なので、そこに一意制約を置く。
-- 失効した購読(404/410)は削除せず revoked_at で無効化する。

CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  device_id    TEXT REFERENCES devices (id),
  member_id    TEXT REFERENCES members (id),
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_sent_at INTEGER,
  failed_count INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX push_subscriptions_endpoint
  ON push_subscriptions (endpoint) WHERE revoked_at IS NULL;
CREATE INDEX push_subscriptions_family
  ON push_subscriptions (family_id, revoked_at);

-- 同じ家庭・同じ日・同じ種類の通知は1回しか送らない。
-- 親が ON した瞬間の送信と、朝の Cron の送信がぶつかるのを、
-- アプリ側の条件分岐ではなく主キーで止める。
CREATE TABLE push_sends (
  family_id TEXT NOT NULL REFERENCES families (id),
  day_key   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (family_id, day_key, kind)
);
```

- [ ] **Step 2: マイグレーションを流す**

```bash
npm run db:reset
```

Expected: エラーなく完了する

- [ ] **Step 3: 失敗するテストを書く**

`tests/api/push.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createHousehold, type Household } from "./client";

/**
 * Web Push の購読。実際の配信はここでは扱わない。
 * 「登録できる」「解除できる」「他の家庭に漏れない」を見る。
 */

let home: Household;

const SUBSCRIPTION = {
  endpoint: "https://push.example.com/sub/abc123",
  keys: { p256dh: "BExamplePublicKey", auth: "ExampleAuthSecret" },
};

beforeAll(async () => {
  home = await createHousehold();
});

describe("購読", () => {
  it("VAPID 公開鍵を取得できる", async () => {
    const result = await home.client.get("/api/push/config");
    expect(result.status).toBe(200);
    // ローカルでは鍵を設定していないので null になる
    expect(result.body).toHaveProperty("publicKey");
  });

  it("登録できる", async () => {
    const result = await home.client.post("/api/push/subscribe", SUBSCRIPTION);
    expect(result.status).toBe(201);
  });

  it("同じ端末が二度登録しても増えない", async () => {
    const result = await home.client.post("/api/push/subscribe", SUBSCRIPTION);
    expect(result.status).toBe(201);
  });

  it("鍵が欠けていたら弾く", async () => {
    const result = await home.client.post("/api/push/subscribe", {
      endpoint: "https://push.example.com/sub/broken",
    });
    expect(result.status).toBe(400);
  });

  it("解除できる", async () => {
    const result = await home.client.del(
      `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`,
    );
    expect(result.status).toBe(200);
  });

  it("他の家庭の購読は解除できない", async () => {
    const other = await createHousehold({ familyName: "よその家" });
    await other.client.post("/api/push/subscribe", SUBSCRIPTION);

    const result = await home.client.del(
      `/api/push/subscribe?endpoint=${encodeURIComponent(SUBSCRIPTION.endpoint)}`,
    );
    // 自分の家庭に無いので「見つからない」
    expect(result.status).toBe(404);
  });
});
```

- [ ] **Step 4: テストが落ちることを確認する**

Run: `npx vitest run --project api tests/api/push.test.ts`
Expected: FAIL（`/api/push/config` が 404）

- [ ] **Step 5: DB 層を実装する**

`src/worker/db/push.ts`:

```ts
import { newId } from "../lib/ids";

/**
 * Web Push の購読と、送信の記録。
 *
 * 購読は endpoint が identity。同じ端末が再登録したときは古い行を無効化して入れ直す。
 * 送信の記録は「同じ日に2回送らない」ための鍵で、状態ではなく通行証として使う。
 */

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SaveSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId: string | null;
  memberId: string | null;
}

export async function saveSubscription(
  db: D1Database,
  familyId: string,
  input: SaveSubscriptionInput,
): Promise<void> {
  const now = Date.now();
  // 同じ endpoint の古い購読を先に無効化する。家庭をまたいで端末が移ることもある。
  await db.batch([
    db
      .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ? AND revoked_at IS NULL")
      .bind(now, input.endpoint),
    db
      .prepare(
        `INSERT INTO push_subscriptions
           (id, family_id, device_id, member_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("psb"),
        familyId,
        input.deviceId,
        input.memberId,
        input.endpoint,
        input.p256dh,
        input.auth,
        now,
      ),
  ]);
}

/** 自分の家庭の購読だけを解除する。無ければ false。 */
export async function removeSubscription(
  db: D1Database,
  familyId: string,
  endpoint: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE push_subscriptions SET revoked_at = ?
        WHERE family_id = ? AND endpoint = ? AND revoked_at IS NULL`,
    )
    .bind(Date.now(), familyId, endpoint)
    .run();
  return result.meta.changes > 0;
}

export async function listSubscriptions(
  db: D1Database,
  familyId: string,
): Promise<StoredSubscription[]> {
  const { results } = await db
    .prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE family_id = ? AND revoked_at IS NULL`,
    )
    .bind(familyId)
    .all<StoredSubscription>();
  return results;
}

export async function markSent(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET last_sent_at = ?, failed_count = 0 WHERE id = ?")
    .bind(at, id)
    .run();
}

/** 5回続けて失敗したら、届かない購読とみなして無効化する */
export async function markFailed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE push_subscriptions
          SET failed_count = failed_count + 1,
              revoked_at = CASE WHEN failed_count + 1 >= 5 THEN ? ELSE revoked_at END
        WHERE id = ?`,
    )
    .bind(Date.now(), id)
    .run();
}

export async function revokeSubscription(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run();
}

/**
 * その日その種類の通知を、この呼び出しが担当してよいかを決める。
 *
 * 先に行を入れてしまい、入れられたほうだけが送る。
 * 「送ったか」をアプリ側で判定すると、即時送信と Cron が同時に走ったときに
 * 両方とも「まだ送っていない」と読んでしまう。
 */
export async function claimSend(
  db: D1Database,
  familyId: string,
  dayKey: string,
  kind: string,
  at: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO push_sends (family_id, day_key, kind, sent_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(familyId, dayKey, kind, at)
    .run();
  return result.meta.changes === 1;
}
```

- [ ] **Step 6: ルータを実装する**

`src/worker/routes/push.ts`:

```ts
import { Hono } from "hono";
import { badRequest, notFound } from "../lib/errors";
import { asString, readJson } from "../lib/validate";
import { removeSubscription, saveSubscription } from "../db/push";
import { getAuth } from "../auth/middleware";
import type { AppBindings } from "../types";

/**
 * 通知の購読。
 *
 * 登録するのは主に子の端末なので、親限定にはしない。
 * ただし family_id と device_id はセッションから決める。クライアントの申告は使わない。
 */
export const pushRoutes = new Hono<AppBindings>();

pushRoutes.get("/push/config", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));

pushRoutes.post("/push/subscribe", async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>(
    c.req.raw,
  );

  const endpoint = asString(body.endpoint, "endpoint", { max: 800 });
  if (!/^https:\/\//.test(endpoint)) throw badRequest("endpoint が不正です");

  const keys = body.keys;
  if (!keys) throw badRequest("鍵が足りません");

  await saveSubscription(c.env.DB, auth.familyId, {
    endpoint,
    p256dh: asString(keys.p256dh, "p256dh", { max: 200 }),
    auth: asString(keys.auth, "auth", { max: 200 }),
    deviceId: auth.device?.id ?? null,
    memberId: auth.lockedMemberId ?? auth.device?.memberId ?? null,
  });

  return c.json({ ok: true }, 201);
});

pushRoutes.delete("/push/subscribe", async (c) => {
  const auth = getAuth(c);
  const endpoint = asString(c.req.query("endpoint"), "endpoint", { max: 800 });
  const removed = await removeSubscription(c.env.DB, auth.familyId, endpoint);
  if (!removed) throw notFound("その購読は見つかりませんでした");
  return c.json({ ok: true });
});
```

- [ ] **Step 7: 環境変数の型を足してルータを登録する**

`src/worker/types.ts` の `AppEnv` に足す:

```ts
  /** Web Push の VAPID 鍵。未設定なら通知は送らない */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
```

`src/worker/index.ts` の import に足す:

```ts
import { pushRoutes } from "./routes/push";
```

`api.route("/", bonusRoutes);` の次に足す:

```ts
api.route("/", pushRoutes);
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `npx vitest run --project api tests/api/push.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 9: コミット**

```bash
git add migrations/0005_push.sql src/worker/db/push.ts src/worker/routes/push.ts src/worker/types.ts src/worker/index.ts tests/api/push.test.ts
git commit -m "Web Push の購読を保存する API を追加"
```

---

### Task 10: 通知の送信

**Files:**
- Create: `src/worker/lib/notify.ts`
- Create: `scripts/make-vapid.mjs`
- Modify: `package.json`
- Modify: `src/worker/routes/bonus.ts`
- Test: `tests/unit/notify.test.ts`、`tests/api/bonus.test.ts`（追記）

**Interfaces:**
- Consumes: Task 9 の DB 関数、Task 3 の `getState`、Task 1 の `dayKey` / `localHour`
- Produces:
  - `BONUS_KIND = "bonus"`
  - `bonusMessage(multiplier: number, key: string): { title: string; body: string; icon: string; tag: string; url: string }`
  - `familiesToNotify(rows: Array<{ familyId: string; timeZone: string }>, at: number): string[]`
  - `notifyBonus(env: AppEnv, familyId: string, at: number): Promise<boolean>`
  - `runBonusNotifications(env: AppEnv, at: number): Promise<number>`

- [ ] **Step 1: ライブラリを入れる**

```bash
npm install @block65/webcrypto-web-push
```

Expected: `dependencies` に1つ増える

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/notify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bonusMessage, familiesToNotify } from "../../src/worker/lib/notify";

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
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run --project unit tests/unit/notify.test.ts`
Expected: FAIL（`notify` が解決できない）

- [ ] **Step 4: 実装する**

`src/worker/lib/notify.ts`:

```ts
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { getState } from "../db/bonus";
import {
  claimSend,
  listSubscriptions,
  markFailed,
  markSent,
  revokeSubscription,
  type StoredSubscription,
} from "../db/push";
import { localHour } from "./day";
import type { AppEnv } from "../types";

/**
 * おしらせ通知。
 *
 * 呼ばれる経路は2つ。親が「今日を2倍にする」を押した瞬間と、毎時の Cron。
 * どちらも同じ関数を通り、同じ日に二度送らないことは push_sends の主キーで守る。
 *
 * VAPID 鍵が無い環境（ローカル開発・テスト）では、通行証だけ取って送信はしない。
 * 「送る条件が揃ったか」はテストできて、実際の配信だけが落ちる形にしてある。
 */

export const BONUS_KIND = "bonus";

/** 家庭のローカル時刻でこの時に朝の通知を送る */
export const SEND_HOUR = 8;

export interface PushMessage {
  title: string;
  body: string;
  icon: string;
  tag: string;
  url: string;
}

export function bonusMessage(multiplier: number, key: string): PushMessage {
  return {
    title: `きょうは ポイント${multiplier}ばい デー！`,
    body: `おてつだいすると シールが ${multiplier}まい もらえるよ。いっぱい ためよう！`,
    icon: "/icons/icon-192.png",
    tag: `bonus-${key}`,
    url: "/",
  };
}

/** ローカル時刻がちょうど送信時刻になっている家庭を選ぶ */
export function familiesToNotify(
  rows: Array<{ familyId: string; timeZone: string }>,
  at: number,
): string[] {
  return rows
    .filter((row) => localHour(at, row.timeZone) === SEND_HOUR)
    .map((row) => row.familyId);
}

/**
 * 1件だけ送る。
 *
 * ライブラリに依存するのはこの関数だけ。引数の形が変わったらここだけ直す。
 */
async function sendOne(
  env: AppEnv,
  subscription: StoredSubscription,
  message: PushMessage,
): Promise<number> {
  const payload = await buildPushPayload(
    { data: JSON.stringify(message), options: { ttl: 60 * 60 * 12 } },
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    {
      subject: env.VAPID_SUBJECT!,
      publicKey: env.VAPID_PUBLIC_KEY!,
      privateKey: env.VAPID_PRIVATE_KEY!,
    },
  );
  const response = await fetch(subscription.endpoint, payload);
  return response.status;
}

function hasVapidKeys(env: AppEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * その家庭に「今日は2倍」を送る。
 * 送る担当になれなかった（既に今日ぶんが送られている）場合は false。
 */
export async function notifyBonus(
  env: AppEnv,
  familyId: string,
  at: number,
): Promise<boolean> {
  const state = await getState(env.DB, familyId, at);
  if (!state.active) return false;

  const claimed = await claimSend(env.DB, familyId, state.dayKey, BONUS_KIND, at);
  if (!claimed) return false;

  if (!hasVapidKeys(env)) {
    console.log("notifyBonus: VAPID 鍵が未設定のため配信を省略", { familyId });
    return true;
  }

  const message = bonusMessage(state.multiplier, state.dayKey);
  const subscriptions = await listSubscriptions(env.DB, familyId);

  for (const subscription of subscriptions) {
    try {
      const status = await sendOne(env, subscription, message);
      // 購読が失効している。掃除して次から送らない。
      if (status === 404 || status === 410) await revokeSubscription(env.DB, subscription.id);
      else if (status >= 400) await markFailed(env.DB, subscription.id);
      else await markSent(env.DB, subscription.id, at);
    } catch (error) {
      console.error("push の送信に失敗", { id: subscription.id, error: String(error) });
      await markFailed(env.DB, subscription.id);
    }
  }
  return true;
}

/** 毎時の Cron から呼ぶ。送信対象になった家庭の数を返す。 */
export async function runBonusNotifications(env: AppEnv, at: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT family_id, timezone FROM family_settings",
  ).all<{ family_id: string; timezone: string }>();

  const targets = familiesToNotify(
    results.map((row) => ({ familyId: row.family_id, timeZone: row.timezone })),
    at,
  );

  let sent = 0;
  for (const familyId of targets) {
    if (await notifyBonus(env, familyId, at)) sent += 1;
  }
  return sent;
}
```

日付とタイムゾーンの解決は `getState` の内側で済むので、
このファイルが直接使うのは `localHour` だけ。

- [ ] **Step 5: 単体テストが通ることを確認する**

Run: `npx vitest run --project unit tests/unit/notify.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 6: 2倍 ON から通知を呼ぶ**

`src/worker/routes/bonus.ts` の import に足す:

```ts
import { notifyBonus } from "../lib/notify";
```

`POST /bonus/today` のハンドラを差し替える:

```ts
bonusRoutes.post("/bonus/today", requireParent, async (c) => {
  const auth = getAuth(c);
  const now = Date.now();
  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  const state = await enableToday(c.env.DB, auth.familyId, now, parentMemberId);
  // 送信そのものが失敗しても、2倍の設定は成立させる
  const notified = await notifyBonus(c.env, auth.familyId, now).catch((error) => {
    console.error("2倍デーの通知に失敗", { familyId: auth.familyId, error: String(error) });
    return false;
  });
  return c.json({ state, notified });
});
```

- [ ] **Step 7: 二重送信のテストを足す**

`tests/api/bonus.test.ts` に追記:

```ts
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
```

- [ ] **Step 8: VAPID 鍵の生成スクリプトを作る**

`scripts/make-vapid.mjs`:

```js
/**
 * VAPID 鍵を作る。
 *
 *   npm run vapid
 *
 * 出た値を、ローカルは .dev.vars に、本番は wrangler secret put で入れる。
 * 秘密鍵は git に入れない。
 */
import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

const toBase64Url = (buffer) =>
  Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const publicKey = toBase64Url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
```

`package.json` の `scripts` に足す（`icons` の隣）:

```json
    "vapid": "node scripts/make-vapid.mjs",
```

- [ ] **Step 9: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（unit / dom / api すべて）

- [ ] **Step 10: コミット**

```bash
git add src/worker/lib/notify.ts src/worker/routes/bonus.ts scripts/make-vapid.mjs package.json package-lock.json tests/unit/notify.test.ts tests/api/bonus.test.ts
git commit -m "2倍デーの通知を送る仕組みを追加"
```

---

### Task 11: 朝の Cron

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: `runBonusNotifications`（Task 10）
- Produces: Worker の `scheduled` ハンドラ

- [ ] **Step 1: Cron を設定する**

`wrangler.jsonc` の `"observability"` の前に足す:

```jsonc
  // 毎時0分に起動し、家庭のローカル時刻が朝8時のところだけに通知を送る。
  // Cloudflare の cron は UTC 固定なので、時差の吸収はアプリ側で行う。
  "triggers": {
    "crons": ["0 * * * *"]
  },
```

- [ ] **Step 2: `scheduled` ハンドラを足す**

`src/worker/index.ts` の import に足す:

```ts
import { runBonusNotifications } from "./lib/notify";
import type { AppEnv } from "./types";
```

末尾の `export default app;` を差し替える:

```ts
/**
 * HTTP と Cron の両方を持つ Worker。
 *
 * 定期実行は「朝8時の家庭に2倍デーの通知を送る」だけ。
 * 判定も送信も notify.ts に置いてあるので、ここは呼ぶだけにしておく。
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      runBonusNotifications(env, Date.now()).catch((error) => {
        console.error("朝の通知に失敗", String(error));
      }),
    );
  },
};
```

- [ ] **Step 3: 型チェックとテストが通ることを確認する**

Run: `npm run build && npm test`
Expected: どちらも成功する

> `app.fetch` を `export default` から差し替えたので、
> `tests/api/server.ts` が立てる dev サーバがそのまま動くことを確認する。
> API テストが全部通れば問題ない。

- [ ] **Step 4: コミット**

```bash
git add src/worker/index.ts wrangler.jsonc
git commit -m "朝8時に2倍デーの通知を送る Cron を追加"
```

---

### Task 12: 端末側の購読と Service Worker

**Files:**
- Create: `src/client/lib/push.ts`
- Modify: `public/sw.js`
- Modify: `src/client/api.ts`
- Modify: `src/client/components/BonusBanner.tsx`
- Test: `tests/dom/BonusBanner.test.tsx`（追記）

**Interfaces:**
- Consumes: Task 9 の `/api/push/*`
- Produces:
  - `canUsePush(): boolean`
  - `pushPermission(): NotificationPermission | "unsupported"`
  - `subscribeToPush(): Promise<boolean>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/dom/BonusBanner.test.tsx` に追記:

```tsx
import * as push from "../../src/client/lib/push";

describe("おしらせのボタン", () => {
  it("Push に対応していない端末には出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.spyOn(push, "canUsePush").mockReturnValue(false);
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "おしらせを うけとる" })).toBeNull();
  });

  it("未許可なら出す", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.spyOn(push, "canUsePush").mockReturnValue(true);
    vi.spyOn(push, "pushPermission").mockReturnValue("default");
    const subscribe = vi.spyOn(push, "subscribeToPush").mockResolvedValue(true);
    renderScreen(<BonusBanner />);

    await userEvent.click(await screen.findByRole("button", { name: "おしらせを うけとる" }));

    expect(subscribe).toHaveBeenCalled();
  });

  it("許可ずみなら出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.spyOn(push, "canUsePush").mockReturnValue(true);
    vi.spyOn(push, "pushPermission").mockReturnValue("granted");
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "おしらせを うけとる" })).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run --project dom tests/dom/BonusBanner.test.tsx`
Expected: FAIL（`lib/push` が解決できない）

- [ ] **Step 3: クライアントの購読処理を実装する**

`src/client/lib/push.ts`:

```ts
import { api } from "../api";

/**
 * Web Push の購読。
 *
 * iOS / iPadOS では、ホーム画面に追加した PWA でしか PushManager が生えない。
 * Safari のタブで開いているときは window.PushManager が無いので、
 * 個別の OS 判定を書かなくても canUsePush() が false になる。
 *
 * 「押したのに何も起きない」が一番わかりにくいので、
 * 使えない端末にはボタンそのものを出さない。
 */

export function canUsePush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): NotificationPermission | "unsupported" {
  if (!canUsePush()) return "unsupported";
  return Notification.permission;
}

/** VAPID の公開鍵は base64url。subscribe() は Uint8Array しか受け取らない。 */
function decodeKey(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** 許可を求めて購読し、サーバに登録する。断られたら false。 */
export async function subscribeToPush(): Promise<boolean> {
  if (!canUsePush()) return false;

  const { publicKey } = await api.pushConfig();
  if (!publicKey) return false;

  if ((await Notification.requestPermission()) !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });

  const json = subscription.toJSON();
  await api.subscribePush({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  });
  return true;
}
```

`src/client/api.ts` の `api` に足す:

```ts
  pushConfig: () => request<{ publicKey: string | null }>("push-config", "/push/config"),

  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    post<{ ok: true }>("push-subscribe", "/push/subscribe", body),
```

- [ ] **Step 4: バナーにボタンを足す**

`src/client/components/BonusBanner.tsx` の import に足す:

```tsx
import { useState } from "react";
import { canUsePush, pushPermission, subscribeToPush } from "../lib/push";
```

`BonusBanner` の中、`if (!active)` の前に足す:

```tsx
  const [asked, setAsked] = useState(false);
  const showNotifyButton = !asked && canUsePush() && pushPermission() === "default";
```

`onStart` のボタンの次に足す:

```tsx
      {showNotifyButton && (
        <button
          type="button"
          className="btn-quiet mt-2"
          onClick={async () => {
            track("action", "bonus-banner:notify");
            await subscribeToPush();
            setAsked(true);
          }}
        >
          おしらせを うけとる
        </button>
      )}
```

- [ ] **Step 5: Service Worker に push を足す**

`public/sw.js` の `VERSION` を上げる:

```js
const VERSION = "v2";
```

ファイル末尾に足す:

```js
/*
 * おしらせ通知。
 *
 * 本文はサーバから届く JSON をそのまま使う。文言を変えるたびに
 * Service Worker を配り直さなくて済むようにしてある。
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? "おてつだいポイント", {
      body: data.body ?? "",
      icon: data.icon ?? "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag ?? "otetsudai",
      data: { url: data.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      // 既に開いているタブがあれば、新しく開かずそれを前に出す
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（unit / dom / api すべて）

- [ ] **Step 7: コミット**

```bash
git add src/client/lib/push.ts src/client/api.ts src/client/components/BonusBanner.tsx public/sw.js tests/dom/BonusBanner.test.tsx
git commit -m "端末で通知を購読できるようにする"
```

---

### Task 13: E2E と手順の記録

**Files:**
- Create: `e2e/bonus.spec.ts`
- Modify: `README.md`
- Modify: `DEPLOY.md`

**Interfaces:**
- Consumes: これまでの全て
- Produces: なし

- [ ] **Step 1: E2E を書く**

`e2e/bonus.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { collectPageErrors, createHouseholdViaApi } from "./helpers";

/**
 * 2倍デーの通し。
 *
 * 実際の Push 配信はブラウザの外の話なので、ここでは扱わない。
 * 「親が ON にすると子の画面に帯が出て、押した倍のシールが貼られる」までを見る。
 */

test("親が2倍にすると、子の台帳で倍のシールが貼られる", async ({ page }) => {
  const errors = collectPageErrors(page);
  const home = await createHouseholdViaApi(page, { capacity: 20 });
  const hana = home.children[0]!;

  // ── 親が今日を2倍にする ───────────────────
  await page.goto("/");
  await page.getByRole("button", { name: /おうちの人/ }).click();
  await page.getByPlaceholder("1234").fill("4821");
  await page.getByRole("button", { name: "せってい" }).click();
  await page.getByRole("button", { name: "今日をポイント2倍にする" }).click();
  await expect(page.getByText("今日はポイント2倍です")).toBeVisible();

  // ── 子の台帳に帯が出る ────────────────────
  await page.goto(`/m/${hana.id}`);
  await expect(page.getByText("きょうは ポイント2ばい デー！")).toBeVisible();

  await page.getByRole("button", { name: "いま おてつだいする" }).click();
  await page.getByRole("button", { name: /おふろそうじ/ }).click();

  // 1回押して2枚。空きマスが2つ減る
  await expect(page.getByTestId("empty-slot")).toHaveCount(18);
  expect(errors).toEqual([]);
});
```

> 親画面に入る導線（`おうちの人` ボタンと PIN 入力）は `e2e/devices.spec.ts` の
> 既存の書き方に合わせる。`empty-slot` の testid は `journey.spec.ts` で使われているもの。

- [ ] **Step 2: E2E を走らせる**

Run: `npm run test:e2e -- bonus.spec.ts`
Expected: PASS

- [ ] **Step 3: README に書き足す**

`README.md` の「よく使うコマンド」に足す:

```bash
npm run vapid         # 通知用の VAPID 鍵を作る(初回のみ)
```

「ローカルで動かす」の環境変数のところに足す:

```
通知を試すときは、`npm run vapid` の出力3行を .dev.vars に貼る。
鍵が無くても通知以外は動く(送信だけが省略される)。
```

- [ ] **Step 4: DEPLOY.md に書き足す**

デプロイ手順のシークレット設定のところに足す:

```bash
# 通知を使う場合のみ。npm run vapid で作った値を入れる
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:you@example.com
```

あわせて注意書きを足す:

```
Cron（毎時0分）は wrangler.jsonc の triggers で設定される。
デプロイ後、Cloudflare のダッシュボードで Trigger が登録されていることを確認する。

iOS / iPadOS で通知を受け取るには、Safari の「ホーム画面に追加」で
PWA として開いている必要がある(16.4 以降)。タブで開いている状態では
通知ボタンそのものが出ない。
```

- [ ] **Step 5: 全部通す**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add e2e/bonus.spec.ts README.md DEPLOY.md
git commit -m "2倍デーの通しテストと、通知の設定手順を追加"
```

---

## 実機での動作確認

コードが揃ったら、以下を実機で確認してスクリーンショットを設計書に貼る。

| # | 確認すること | 端末 |
|---|---|---|
| 1 | 親設定で今日を2倍にすると通知が届く | Android Chrome / PC |
| 2 | 通知をタップするとアプリが開く | 同上 |
| 3 | 台帳に帯が出て「いま おてつだいする」でお手伝いに進む | 任意 |
| 4 | 3回押すとシールが6枚貼られる | 任意 |
| 5 | ホーム画面追加した iPad で通知が届く | iPadOS 16.4+ |
| 6 | Safari のタブで開くと「おしらせを うけとる」が出ない | iPadOS |

## ターン数

| | ターン数 |
|---|---|
| 予定 | 設計 5 / 実装 13 |
| 実際 | （完了時に記入） |
