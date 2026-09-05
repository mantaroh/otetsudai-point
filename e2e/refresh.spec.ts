import { expect, test } from "@playwright/test";
import { createHouseholdViaApi, signInFresh, stickViaApi } from "./helpers";

/**
 * 裏での再取得のふるまい。
 *
 * デプロイ後に「はじめの設定を入力していると、15秒ごとに内容が消える」という形で出た不具合の再発防止。
 * 実際の待ち時間で確かめたいので、ここは jsdom ではなく実ブラウザで見る。
 */

test("はじめの設定は、しばらく置いても入力が消えない", async ({ page }) => {
  test.setTimeout(90_000);

  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await signInFresh(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "はじめの設定" })).toBeVisible();

  await page.getByPlaceholder("やまだ家").fill("やまだ家");
  await page.getByPlaceholder("1人目の名前").fill("はな");

  // 定期再取得の間隔(15秒)をまたいで待つ
  await page.waitForTimeout(25_000);

  await expect(page.getByPlaceholder("やまだ家")).toHaveValue("やまだ家");
  await expect(page.getByPlaceholder("1人目の名前")).toHaveValue("はな");
  expect(navigations, "画面が読み込み直されている").toBe(1);
});

test("台帳を開いたままでも、他の端末で貼られたシールが出てくる", async ({ page }) => {
  test.setTimeout(90_000);

  const home = await createHouseholdViaApi(page, { capacity: 30 });
  const hana = home.children[0]!;
  await stickViaApi(page, hana.id, home.choreId, 2);

  await page.goto(`/m/${hana.id}`);
  await expect(page.getByTestId("sticker")).toHaveCount(2);

  // 別の端末から貼られた、という状況
  await stickViaApi(page, hana.id, home.choreId, 1);

  // 開いたまま放っておいても、そのうち反映される
  await expect(page.getByTestId("sticker")).toHaveCount(3, { timeout: 30_000 });
});
