import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * テストは3層に分ける。速いものから落ちるようにしておくと、原因の切り分けが早い。
 *
 *   unit … 純粋なロジック。DB もサーバも要らない。ミリ秒で回る
 *   dom  … 画面のふるまい。jsdom + Testing Library。API はモックする
 *   api  … 実際の Worker + D1 に対する結合テスト。dev サーバを立てて叩く
 *
 * 実ブラウザでの通しテストは Playwright(playwright.config.ts)が受け持つ。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/dom/**/*.test.tsx"],
          setupFiles: ["tests/dom/setup.ts"],
          globals: true,
        },
      },
      {
        test: {
          name: "api",
          environment: "node",
          include: ["tests/api/**/*.test.ts"],
          globalSetup: ["tests/api/server.ts"],
          // 同じローカル D1 を共有するので、ファイル間の並列実行はしない
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
