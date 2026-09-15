import { expect, test } from "@playwright/test";
import {
  claimInviteInBrowser,
  collectPageErrors,
  createInvite,
  createHouseholdViaApi,
  signInFresh,
  stickViaApi,
} from "./helpers";

/**
 * 実ブラウザでの通し。
 * 家庭を作って、シールを貼って、いっぱいにして、ハンコをもらって、本棚で見る。
 * うちで実際にやる操作を、そのままの順序でなぞる。
 */

test("はじめの設定から、シールを貼って交換して、本棚に残るまで", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signInFresh(page);

  // ── オンボーディング ───────────────────────
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "はじめの設定" })).toBeVisible();

  await page.getByPlaceholder("やまだ家").fill("やまだ家");
  await page.getByPlaceholder("おかあさん").fill("おとうさん");
  await page.getByPlaceholder("1234").fill("4821");
  await page.getByPlaceholder("1人目の名前").fill("はな");
  await page.getByPlaceholder("2人目の名前").fill("たろう");
  await page.getByRole("button", { name: "20", exact: true }).click();
  await page.getByRole("button", { name: "はじめる" }).click();

  // ── だれ? の画面 ──────────────────────────
  await expect(page.getByRole("heading", { name: "おてつだいポイント" })).toBeVisible();
  await expect(page.getByText("やまだ家")).toBeVisible();
  await expect(page.getByRole("button", { name: /はな/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /たろう/ })).toBeVisible();

  // ── 台帳 ──────────────────────────────────
  await page.getByRole("button", { name: /はな/ }).click();
  await expect(page.getByRole("heading", { name: "はなのだいちょう" })).toBeVisible();
  await expect(page.getByText("あと 20 まい")).toBeVisible();
  await expect(page.getByTestId("empty-slot")).toHaveCount(20);

  // ── シールを貼る(押した回数だけ貼られる) ──
  await page.getByRole("button", { name: /おふろそうじ/ }).click();
  const stick = page.getByRole("button", { name: "シールをはる" });

  await stick.click();
  await expect(page.getByTestId("sticker")).toHaveCount(1);
  await expect(page.getByText("あと 19 まい")).toBeVisible();

  await stick.click();
  await stick.click();
  await expect(page.getByTestId("sticker")).toHaveCount(3);

  // 1枚もどす
  await page.getByRole("button", { name: "1まいもどす" }).click();
  await expect(page.getByTestId("sticker")).toHaveCount(2);
  await expect(page.getByText("あと 18 まい")).toBeVisible();

  // 残りは一気に埋める
  for (let i = 0; i < 18; i++) await stick.click();
  await expect(page.getByTestId("sticker")).toHaveCount(20);
  await expect(page.getByTestId("empty-slot")).toHaveCount(0);
  await expect(page.getByText("いっぱいになったよ!")).toBeVisible();

  // ── こうかんしたい ────────────────────────
  await page.getByRole("button", { name: /こうかんしたい/ }).click();
  await expect(page.getByText(/おうちの人にわたしたよ/)).toBeVisible();

  // ── 親のハンコ ────────────────────────────
  await page.getByRole("button", { name: "もどる" }).click();
  await expect(page.getByRole("button", { name: /こうかんまち 1/ })).toBeVisible();
  await page.getByRole("button", { name: /おうちの人のがめん/ }).click();

  await expect(page.getByRole("heading", { name: "おうちの人のがめん" })).toBeVisible();
  await page.getByRole("button", { name: /ハンコをおして交換する.*リクエストあり/ }).click();

  await expect(page.getByRole("heading", { name: /はなの1さつめを交換/ })).toBeVisible();
  await page.getByPlaceholder(/Robux/).fill("Robux 1200");
  await page.getByRole("button", { name: "Roblox" }).click();
  await page.getByRole("button", { name: "ハンコをおす" }).click();

  // 交換が済んだら、ハンコのボタンは消える
  await expect(page.getByRole("button", { name: /ハンコをおして交換する/ })).toHaveCount(0);
  // はなの台帳は2さつめに切り替わり、空になっている
  await expect(page.getByText("2さつめ ・ 0 / 20 まい")).toBeVisible();

  // ── 本棚 ──────────────────────────────────
  await page.getByRole("button", { name: "もどる" }).click();
  await page.getByRole("button", { name: /はな/ }).click();
  await page.getByRole("button", { name: "ほんだな" }).click();

  await expect(page.getByRole("heading", { name: "はなのほんだな" })).toBeVisible();
  await expect(page.getByText("1さつめ")).toBeVisible();
  await expect(page.getByText("こうかんしたもの")).toBeVisible();
  await expect(page.getByText("Robux 1200")).toBeVisible();

  // ── 新しい台帳が始まっている ──────────────
  await page.getByRole("button", { name: "もどる" }).click();
  await expect(page.getByText("あと 20 まい")).toBeVisible();
  await expect(page.getByText(/2さつめ/)).toBeVisible();

  expect(errors).toEqual([]);
});

test("繰り越しても、渡す前の台帳が画面から消えない", async ({ page }) => {
  const errors = collectPageErrors(page);
  const home = await createHouseholdViaApi(page, { capacity: 5 });
  const hana = home.children[0]!;

  // 5マスの台帳に7枚 → 1冊目が満了し、2冊目に2枚が乗る
  await stickViaApi(page, hana.id, home.choreId, 7);

  await page.goto(`/m/${hana.id}`);

  // いま貼れるのは2冊目
  await expect(page.getByText(/2さつめ/)).toBeVisible();
  await expect(page.getByTestId("sticker")).toHaveCount(2);

  // 1冊目は、交換できるものとしてちゃんと出ている
  await page.getByRole("button", { name: "1さつめこうかんしたい!" }).click();
  await expect(page.getByText(/1さつめおうちの人にわたしたよ/)).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * 名前は変わる。呼び名が変わることもあれば、下の子が自分で決め直すこともある。
 * 変えても台帳や記録は同じ人のものとして引き継がれること、
 * 表示だけが新しい名前になることを確かめる。
 */
test("子どもの名前をあとから変えられる", async ({ page }) => {
  const errors = collectPageErrors(page);
  const home = await createHouseholdViaApi(page, { capacity: 30 });
  const hana = home.children[0]!;
  await stickViaApi(page, hana.id, home.choreId, 2);

  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();

  const family = page.locator("section", { has: page.getByRole("heading", { name: "家族" }) });
  await family.getByRole("button", { name: /はな/ }).click();
  // exact にしておく。せってい画面には「あたらしいお手伝いの名前」なども常に出ていて、
  // getByLabel は既定で部分一致なので、「名前」だけだと複数に当たる
  await page.getByLabel("名前", { exact: true }).fill("はなこ");
  await page.getByRole("button", { name: "ほぞん" }).click();

  // 親の画面に反映される
  await page.getByRole("button", { name: "だいちょう" }).click();
  await expect(page.getByText("はなこ")).toBeVisible();

  // だれ? の画面にも
  await page.goto("/");
  await expect(page.getByRole("button", { name: /はなこ/ })).toBeVisible();

  // 台帳とシールは、同じ人のものとして引き継がれる
  await page.goto(`/m/${hana.id}`);
  await expect(page.getByRole("heading", { name: "はなこのだいちょう" })).toBeVisible();
  await expect(page.getByTestId("sticker")).toHaveCount(2);

  expect(errors).toEqual([]);
});

/**
 * 家族は増えるし、参加しなくなることもある。
 * 「はずす」で記録が消えないこと、戻せば台帳が続くことを実ブラウザで確かめる。
 */
test("家族をふやして、はずして、もどせる", async ({ page }) => {
  const errors = collectPageErrors(page);
  await createHouseholdViaApi(page, { capacity: 30 });

  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();
  const family = page.locator("section", { has: page.getByRole("heading", { name: "家族" }) });

  // ふやす。子どもなら、その場で台帳が始まる
  await family.getByRole("button", { name: /家族をふやす/ }).click();
  await page.getByLabel("あたらしい家族の名前").fill("みなみ");
  await page.getByRole("button", { name: "ふやす" }).click();
  await expect(family.getByRole("button", { name: /みなみ/ })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("button", { name: /みなみ/ })).toBeVisible();

  // 追加した直後から貼れる
  await page.getByRole("button", { name: /みなみ/ }).click();
  await page.getByRole("button", { name: /おふろそうじ/ }).click();
  await page.getByRole("button", { name: "シールをはる" }).click();
  await expect(page.getByTestId("sticker")).toHaveCount(1);

  // はずす。確認では、記録が残ることを伝える
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("記録は残ります");
    void dialog.accept();
  });
  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();
  await family.getByRole("button", { name: /みなみ/ }).click();
  await page.getByRole("button", { name: /この人を家族からはずす/ }).click();

  await expect(family.getByRole("button", { name: /みなみ/ })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /みなみ/ })).toHaveCount(0);

  // もどすと、そのときの台帳から続けられる
  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();
  await expect(page.getByText("しまってある人")).toBeVisible();
  await page.getByRole("button", { name: "もどす" }).click();

  await page.goto("/");
  await page.getByRole("button", { name: /みなみ/ }).click();
  await expect(page.getByTestId("sticker")).toHaveCount(1);

  expect(errors).toEqual([]);
});

test("端末の名前を変えられ、種類が分かる", async ({ page, browser }) => {
  const errors = collectPageErrors(page);
  await createHouseholdViaApi(page, { capacity: 5 });

  // まず1台登録しておく
  const invitePath = await createInvite(page, { kind: "shared", label: "なまえ未設定" });
  const tablet = await browser.newContext();
  await claimInviteInBrowser(await tablet.newPage(), invitePath);
  await tablet.close();

  await page.goto("/parent");
  await page.getByRole("button", { name: "せってい" }).click();

  // 何ができる端末なのかが、名前を見なくても分かる
  await expect(page.getByText("なまえ未設定")).toBeVisible();
  await expect(page.getByText(/だれの台帳にも貼れる/)).toBeVisible();

  await page.getByRole("button", { name: "名前を変える" }).click();
  await page.getByLabel("端末の名前").fill("リビングのiPad");
  await page.getByRole("button", { name: "ほぞん" }).click();

  await expect(page.getByText("リビングのiPad")).toBeVisible();
  await expect(page.getByText("なまえ未設定")).toHaveCount(0);
  // 種類は変わらない
  await expect(page.getByText(/だれの台帳にも貼れる/)).toBeVisible();

  expect(errors).toEqual([]);
});

test("スマホの幅でも、台帳が横にはみ出さない", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 375, height: 667 });

  const home = await createHouseholdViaApi(page, { capacity: 30 });
  const hana = home.children[0]!;
  await stickViaApi(page, hana.id, home.choreId, 12);

  await page.goto(`/m/${hana.id}`);
  await expect(page.getByTestId("sticker")).toHaveCount(12);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // 貼るボタンは画面下に固定されていて、常に押せる
  await expect(page.getByText("なにをした?")).toBeInViewport();

  expect(errors).toEqual([]);
});
