import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { API_PORT, BASE_URL } from "./client";

/**
 * 結合テスト用の dev サーバ。
 *
 * まっさらな D1 から始めたいので、サーバを起こす前にローカルの D1 を作り直す
 * (起動後は workerd がファイルを掴んでいて消せない)。
 * 開発中の `npm run dev` と衝突しないよう、ポートは別にしてある。
 */

let server: ChildProcess | null = null;

export default async function setup() {
  rmSync(".wrangler/state/v3/d1", { recursive: true, force: true });

  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "otetsudai-point", "--local"],
    { shell: true, encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    throw new Error(`マイグレーションに失敗しました:\n${migrate.stdout}\n${migrate.stderr}`);
  }

  server = spawn("npx", ["vite", "--port", String(API_PORT), "--strictPort"], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  await waitForReady(logs);

  return async () => {
    killTree(server);
    server = null;
  };
}

async function waitForReady(logs: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      // 未認証なら 401 が返る。返ってくること自体が「起きている」の合図
      const response = await fetch(`${BASE_URL}/api/me`);
      if (response.status === 401) return;
    } catch {
      // まだ起きていない
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  killTree(server);
  throw new Error(`dev サーバが起動しませんでした:\n${logs.join("")}`);
}

/**
 * Windows では vite の子として workerd が立つので、プロセスツリーごと落とす。
 * 取りこぼすと D1 のファイルが掴まれたままになり、次回の作り直しが EPERM で失敗する。
 */
function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
