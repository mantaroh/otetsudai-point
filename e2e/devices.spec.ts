import { expect, test } from "@playwright/test";
import {
  claimInviteInBrowser,
  collectPageErrors,
  createHouseholdViaApi,
  createInvite,
  stickViaApi,
} from "./helpers";

/**
 * 端末の使い分け。
 * 子供にアカウントを持たせない設計が、実ブラウザでも成り立っているかを見る。
 */

test("招待リンクを開いた共有タブレットは、ログインなしで使える", async ({ page, browser }) => {
  const home = await createHouseholdViaApi(page, { capacity: 5 });
  const invitePath = await createInvite(page, { kind: "shared", label: "リビングのタブレット" });

  // まっさらなブラウザ = まだ何の Cookie も持っていない端末
  const tablet = await browser.newContext();
  const tabletPage = await tablet.newPage();
  const errors = collectPageErrors(tabletPage);

  await tabletPage.goto("/");
  await expect(tabletPage.getByRole("heading", { name: "おてつだいポイント" })).toBeVisible();
  await expect(tabletPage.getByRole("link", { name: /Google でログイン/ })).toBeVisible();

  // 招待リンクを開くと、そのまま使えるようになる
  await claimInviteInBrowser(tabletPage, invitePath);
  await expect(tabletPage.getByRole("button", { name: /はな/ })).toBeVisible();
  await expect(tabletPage.getByRole("button", { name: /たろう/ })).toBeVisible();

  // 子は自分でシールを貼れる
  await tabletPage.getByRole("button", { name: /はな/ }).click();
  await tabletPage.getByRole("button", { name: /おふろそうじ/ }).click();
  await tabletPage.getByRole("button", { name: "シールをはる" }).click();
  await expect(tabletPage.getByTestId("sticker")).toHaveCount(1);

  expect(errors).toEqual([]);
  await tablet.close();
});

/**
 * LINE に招待リンクを送ったら、リンクプレビューの取得に使い切られて
 * 「このリンクは使用ずみです」になった。
 *
 * リンクを開くのは本人とは限らない。開くだけでは何も起こらないことを、
 * 実ブラウザでも確かめる。
 */
test("招待リンクは、開いただけでは登録されない", async ({ page, browser }) => {
  await createHouseholdViaApi(page, { capacity: 5 });
  const invitePath = await createInvite(page, { kind: "shared", label: "リビングのタブレット" });

  // プレビュー取得のように、リンクを開くだけ
  const bot = await browser.newContext();
  const botPage = await bot.newPage();
  await botPage.goto(invitePath);
  await expect(botPage.getByRole("heading", { name: "この端末を登録しますか?" })).toBeVisible();
  // 何が登録されるのかが、押す前に分かる
  await expect(botPage.getByText("リビングのタブレット")).toBeVisible();
  await expect(botPage.getByText(/まだ何も登録されていません/)).toBeVisible();
  await bot.close();

  // 親から見ても、端末は増えていない
  const devices = await page.request.get("/api/devices");
  expect(await devices.json()).toHaveLength(0);

  // そのあとで、本人がちゃんと登録できる
  const tablet = await browser.newContext();
  const tabletPage = await tablet.newPage();
  await claimInviteInBrowser(tabletPage, invitePath);
  await expect(tabletPage.getByRole("button", { name: /はな/ })).toBeVisible();
  await tablet.close();
});

/**
 * LINE でリンクをタップすると、既定ではアプリ内ブラウザで開く。
 * そこで登録しても Cookie はアプリ内ブラウザにしか残らないので、
 * openExternalBrowser=1 を付けて既定のブラウザで開かせる。
 *
 * 付けた URL でもちゃんと登録できること(クエリでルーティングが壊れないこと)まで確かめる。
 */
test("せっていから発行すると、QR と LINE 用の URL が出る", async ({ page, browser }) => {
  await createHouseholdViaApi(page, { capacity: 5 });

  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();
  await page.getByRole("button", { name: /共有タブレット用のリンクを発行/ }).click();

  // 渡したい端末のカメラで読めるように QR が出る
  await expect(page.getByRole("img", { name: "招待リンクの QR コード" })).toBeVisible();

  // LINE 用の印は、はじめから付いている
  await expect(page.getByRole("checkbox", { name: /LINE で送る用にする/ })).toBeChecked();
  const url = (await page.getByTestId("invite-url").innerText()).trim();
  expect(url).toContain("openExternalBrowser=1");

  // 外すと素の URL に戻る
  await page.getByRole("checkbox", { name: /LINE で送る用にする/ }).uncheck();
  expect(await page.getByTestId("invite-url").innerText()).not.toContain("openExternalBrowser");
  await page.getByRole("checkbox", { name: /LINE で送る用にする/ }).check();

  // 印が付いた URL のまま開いても、ちゃんと登録できる
  const parsed = new URL(url);
  const tablet = await browser.newContext();
  const tabletPage = await tablet.newPage();
  await claimInviteInBrowser(tabletPage, parsed.pathname + parsed.search);
  await expect(tabletPage.getByRole("button", { name: /はな/ })).toBeVisible();
  await tablet.close();
});

test("使いおわった招待リンクを開くと、その旨が出る", async ({ page, browser }) => {
  await createHouseholdViaApi(page, { capacity: 5 });
  const invitePath = await createInvite(page, { kind: "shared", label: "タブレット" });

  const first = await browser.newContext();
  await claimInviteInBrowser(await first.newPage(), invitePath);
  await first.close();

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto(invitePath);
  await expect(secondPage.getByRole("heading", { name: "このリンクは使用ずみです" })).toBeVisible();
  await expect(secondPage.getByText(/もう一度リンクを発行/)).toBeVisible();
  await second.close();
});

test("共有タブレットからの交換には、PIN のテンキーが出る", async ({ page, browser }) => {
  const home = await createHouseholdViaApi(page, { capacity: 5, pin: "4821" });
  const hana = home.children[0]!;
  await stickViaApi(page, hana.id, home.choreId, 5);

  const invitePath = await createInvite(page, { kind: "shared", label: "タブレット" });
  const tablet = await browser.newContext();
  const tabletPage = await tablet.newPage();
  const errors = collectPageErrors(tabletPage);

  await claimInviteInBrowser(tabletPage, invitePath);
  await tabletPage.getByRole("button", { name: /おうちの人のがめん/ }).click();
  await tabletPage.getByRole("button", { name: /ハンコをおして交換する/ }).click();

  await tabletPage.getByPlaceholder(/Robux/).fill("まんが");
  await tabletPage.getByRole("button", { name: "ハンコをおす" }).click();

  // ログインしていない端末なので、ここで PIN を求められる
  await expect(tabletPage.getByRole("heading", { name: "おうちの人のPIN" })).toBeVisible();

  // まちがえたら教えてくれる
  for (const digit of "0000") {
    await tabletPage.getByRole("button", { name: digit, exact: true }).click();
  }
  await tabletPage.getByRole("button", { name: "OK" }).click();
  await expect(tabletPage.getByText("PIN がちがいます")).toBeVisible();

  // 正しい PIN を入れると、交換がそのまま続行される
  for (const digit of "4821") {
    await tabletPage.getByRole("button", { name: digit, exact: true }).click();
  }
  await tabletPage.getByRole("button", { name: "OK" }).click();

  await expect(tabletPage.getByRole("heading", { name: "おうちの人のPIN" })).toHaveCount(0);
  await expect(tabletPage.getByRole("button", { name: /ハンコをおして交換する/ })).toHaveCount(0);

  expect(errors).toEqual([]);
  await tablet.close();
});

test("子ども専用端末は、自分の台帳だけが開く", async ({ page, browser }) => {
  const home = await createHouseholdViaApi(page, { capacity: 5 });
  const taro = home.children[1]!;
  const invitePath = await createInvite(page, {
    kind: "child",
    label: "たろうのスマホ",
    memberId: taro.id,
  });

  const phone = await browser.newContext();
  const phonePage = await phone.newPage();
  const errors = collectPageErrors(phonePage);

  await claimInviteInBrowser(phonePage, invitePath);

  // だれ? の画面を通らずに、自分の台帳へ直行する
  await expect(phonePage.getByRole("heading", { name: "たろうのだいちょう" })).toBeVisible();
  await expect(phonePage).toHaveURL(new RegExp(`/m/${taro.id}$`));

  // きょうだいの台帳には入れない
  await phonePage.goto(`/m/${home.children[0]!.id}`);
  await expect(phonePage.getByRole("heading", { name: "たろうのだいちょう" })).toBeVisible();

  // おうちの人のがめんにも入れない
  await phonePage.goto("/parent");
  await expect(phonePage.getByRole("heading", { name: "たろうのだいちょう" })).toBeVisible();

  expect(errors).toEqual([]);
  await phone.close();
});
