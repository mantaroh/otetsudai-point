import { defineConfig, devices } from "@playwright/test";

/**
 * 実ブラウザでの通しテスト。
 *
 * jsdom のコンポーネントテストでは拾えないもの
 * (アセットが配信されない、SPA のルーティングが効いていない、
 *  ビルド後に真っ白になる、といった類)をここで検出する。
 *
 * dev サーバは Playwright が起こす。起こす前にローカル D1 を作り直すので、
 * 毎回まっさらな状態から「家庭を作るところ」を通る。
 * 開発中の `npm run dev`(5173)や API 結合テスト(5174)とはポートを分けてある。
 */
const PORT = 5175;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // 実ブラウザ + dev サーバで、シールを何十回も押す通しテストがある。
  // 既定の30秒だと、遅いというだけで落ちる。
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },

  // リビングのタブレットが主戦場なので、既定はその画面サイズで見る。
  // スマホ幅での崩れは、個別のテスト内で viewport を切り替えて確かめる。
  projects: [{ name: "tablet", use: { ...devices["iPad (gen 7)"] } }],

  webServer: {
    command: `npm run db:reset && npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/me`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
