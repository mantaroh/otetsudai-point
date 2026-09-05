import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom には randomUUID が無いことがあるが、シールの楽観表示のキー生成に使っている
if (!globalThis.crypto?.randomUUID) {
  const { randomUUID } = await import("node:crypto");
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: randomUUID, configurable: true });
}

// jsdom の window.confirm は「未実装」を出して undefined を返すだけなので、
// 既定では OK が押されたことにする。打ち消したい場合は各テストで spyOn する。
//
// 毎回貼り直すのが要点。vi.clearAllMocks() は呼び出し履歴を消すだけで
// spyOn で差し替えた中身は戻らないため、「取り消した」テストの設定が
// あとのテストに漏れて、原因の分かりにくい失敗になる。
beforeEach(() => {
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
