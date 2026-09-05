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
  // API 経由で家庭を作った時点で、この page はもう親としてログイン済みなので
  // /parent に直接入れる(PIN のテンキーが要るのは、ログインしていない共有端末から
  // 親の操作をするときだけ。devices.spec.ts のテンキーのテストを参照)。
  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();
  await page.getByRole("button", { name: "今日をポイント2倍にする" }).click();
  await expect(page.getByText("今日はポイント2倍です")).toBeVisible();

  // ── 子の台帳に帯が出る ────────────────────
  await page.goto(`/m/${hana.id}`);
  await expect(page.getByText("きょうは ポイント2ばい デー！")).toBeVisible();

  // 帯の「いま おてつだいする」は、お手伝いを選ぶ場所までスクロールするだけ。
  // 実際に貼るのは、そこから普段どおりお手伝いを選んで「シールをはる」を押したとき。
  await page.getByRole("button", { name: "いま おてつだいする" }).click();
  await page.getByRole("button", { name: /おふろそうじ/ }).click();

  // 台帳は押した瞬間に楽観表示でシールを置く(Ledger.tsx の pending)。
  // その枚数もクライアント側で multiplier を掛けて計算しているので、
  // リロードせずに数えると、サーバが実際には倍にしていなくても
  // 同じ2枚に見えてしまい、このテストの意味が無くなる。
  // なので POST /api/grants の完了を待ってからリロードし、
  // 楽観表示を消したあと(=サーバに保存された分だけ)を数える。
  const granted = page.waitForResponse(
    (response) => response.url().includes("/api/grants") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "シールをはる" }).click();
  const response = await granted;
  expect(response.status()).toBe(201);

  await page.reload();

  // 1回押しただけで2枚貼られている。空きマスが2つ減る
  await expect(page.getByTestId("sticker")).toHaveCount(2);
  await expect(page.getByTestId("empty-slot")).toHaveCount(18);
  // リロード後も帯が出ている = bonusToday はクライアントの一時状態ではなく、
  // bootstrap から取り直しても残るサーバ側の状態であることの確認
  await expect(page.getByText("きょうは ポイント2ばい デー！")).toBeVisible();

  expect(errors).toEqual([]);
});
