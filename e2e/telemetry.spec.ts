import { expect, test } from "@playwright/test";
import { collectPageErrors, createHouseholdViaApi } from "./helpers";

/**
 * 画面の操作記録が、実ブラウザで本当に届くか。
 *
 * ここでしか確かめられないことがある。記録は sendBeacon で送っていて、
 * jsdom には sendBeacon が無いし、画面テストでは送信そのものを差し替えている。
 * 「実際のブラウザで、画面を離れるときに送り切れているか」はこの層で押さえる。
 */

test("だいちょうでの操作が記録され、つかわれかたに出る", async ({ page }) => {
  const errors = collectPageErrors(page);
  const home = await createHouseholdViaApi(page);
  const hana = home.children[0]!;

  await page.goto("/");
  await page.getByRole("button", { name: /はな/ }).first().click();
  await expect(page.getByRole("heading", { name: "はなのだいちょう" })).toBeVisible();

  // お手伝いを選んでシールを2枚貼る
  await page.getByRole("button", { name: /おふろ|そうじ|さんぽ/ }).first().click();
  await page.getByRole("button", { name: "シールをはる" }).click();
  await page.getByRole("button", { name: "シールをはる" }).click();

  // 反応しない場所(台帳のマス)をタップする。子どもが必ずやる操作
  await page.locator('[data-zone="sheet-grid"]').click({ position: { x: 5, y: 5 } });

  // 画面を離れると、溜まっていたぶんが送られる
  await page.getByRole("button", { name: "もどる" }).click();
  await expect(page.getByRole("heading", { name: "おてつだいポイント" })).toBeVisible();

  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/insights?days=1");
        return (await response.json()) as {
          events: number;
          funnel: { opened: number; picked: number; stuck: number };
          actions: Array<{ name: string; count: number }>;
          frictions: Array<{ name: string; detail: string | null }>;
          members: Array<{ memberId: string; sticks: number }>;
        };
      },
      { timeout: 15_000 },
    )
    .toMatchObject({
      funnel: { opened: 1, picked: 1, stuck: 1 },
      actions: expect.arrayContaining([{ name: "stick", screen: null, detail: null, count: 2 }]),
      frictions: expect.arrayContaining([
        expect.objectContaining({ name: "dead-tap", detail: "sheet-grid" }),
      ]),
      members: expect.arrayContaining([expect.objectContaining({ memberId: hana.id, sticks: 2 })]),
    });

  expect(errors).toEqual([]);
});

test("記録しない設定にすると、1件も残らない", async ({ page }) => {
  const errors = collectPageErrors(page);
  await createHouseholdViaApi(page);

  const patched = await page.request.patch("/api/settings", { data: { uiLogDays: 0 } });
  expect(patched.status()).toBe(200);

  await page.goto("/");
  await page.getByRole("button", { name: /はな/ }).first().click();
  await expect(page.getByRole("heading", { name: "はなのだいちょう" })).toBeVisible();
  await page.getByRole("button", { name: "もどる" }).click();
  await expect(page.getByRole("heading", { name: "おてつだいポイント" })).toBeVisible();

  const report = await (await page.request.get("/api/insights?days=1")).json();
  expect(report.events).toBe(0);

  expect(errors).toEqual([]);
});
