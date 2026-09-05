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
  await page.getByRole("button", { name: "シールをはる" }).click();

  // 1回押しただけで2枚貼られる。空きマスが2つ減る
  await expect(page.getByTestId("sticker")).toHaveCount(2);
  await expect(page.getByTestId("empty-slot")).toHaveCount(18);

  expect(errors).toEqual([]);
});
