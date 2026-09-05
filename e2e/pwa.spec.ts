import { expect, test } from "@playwright/test";
import { createHouseholdViaApi } from "./helpers";

/**
 * ホーム画面に追加して使うための持ち物が、ちゃんと配信されているか。
 *
 * manifest やアイコンは画面に出ないので、抜けても普通に使えてしまい、
 * 「ホーム画面に追加したのにブラウザの枠が出る」まで気づけない。
 */

test("manifest が配信され、ホーム画面に追加できる形になっている", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);

  const manifest = await response.json();
  expect(manifest.name).toBe("おてつだいポイント");
  expect(manifest.start_url).toBe("/");
  // ブラウザの枠なしで開くための指定
  expect(manifest.display).toBe("standalone");
  expect(manifest.theme_color).toBeTruthy();

  // Android のホーム画面では 192 と 512、さらに切り抜き用の maskable が要る
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true);
});

test("アイコンが実際に取得でき、中身が PNG になっている", async ({ page }) => {
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  const paths = [
    ...manifest.icons.map((icon: { src: string }) => icon.src),
    "/icons/apple-touch-icon.png",
    "/icons/favicon-32.png",
  ];

  for (const path of paths) {
    const response = await page.request.get(path);
    expect(response.status(), `${path} が取得できない`).toBe(200);

    const body = await response.body();
    // PNG のシグネチャ
    expect(body.subarray(0, 4).toString("hex"), `${path} が PNG ではない`).toBe("89504e47");
    expect(body.length).toBeGreaterThan(200);
  }
});

test("HTML から manifest と iOS 用アイコンが参照されている", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  // iOS はまだ manifest のアイコンを見ないので、個別指定が要る
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#fdf7ec");
});

test("Service Worker が配信され、台帳のデータをキャッシュしない", async ({ page }) => {
  const response = await page.request.get("/sw.js");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("javascript");

  const source = await response.text();
  // シールの枚数が古いまま出るのがいちばん困るので、API は必ず素通しにする
  expect(source).toMatch(/\/\^\\\/\(api\|auth\|invite\)/);
});

test("読み込みに失敗しても、画面が真っ白にならない", async ({ page, context }) => {
  // 先に一度開いて、家庭を作っておく
  await createHouseholdViaApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "おてつだいポイント" })).toBeVisible();

  // 通信できない状態にして開き直す
  await context.setOffline(true);
  await page.reload().catch(() => {});

  // 真っ白ではなく、何か手がかりが出ていること
  const text = await page.locator("body").innerText();
  expect(text.trim().length).toBeGreaterThan(0);

  await context.setOffline(false);
});
