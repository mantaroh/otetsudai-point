import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BonusState } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return { ...actual, api: { bootstrap: vi.fn() } };
});

vi.mock("../../src/client/lib/push", () => ({
  canUsePush: vi.fn(),
  pushPermission: vi.fn(),
  subscribeToPush: vi.fn(),
}));

import { api } from "../../src/client/api";
import { canUsePush, pushPermission, subscribeToPush } from "../../src/client/lib/push";
import { BonusBanner } from "../../src/client/components/BonusBanner";
import { makeBootstrap, renderScreen } from "./helpers";

const ON: BonusState = { active: true, multiplier: 2, source: "once", dayKey: "2026-09-05" };

beforeEach(() => {
  vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());
  vi.mocked(canUsePush).mockReturnValue(true);
  vi.mocked(pushPermission).mockReturnValue("default");
  vi.mocked(subscribeToPush).mockResolvedValue(true);
});

describe("2倍デーのバナー", () => {
  it("ふだんの日は出ない", async () => {
    renderScreen(<BonusBanner />);
    // bootstrap の解決を待ってから、出ていないことを確かめる
    expect(await screen.findByTestId("bonus-banner-slot")).toBeEmptyDOMElement();
  });

  it("2倍の日は帯が出る", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    renderScreen(<BonusBanner />);

    expect(await screen.findByText("きょうは ポイント2ばい デー！")).toBeInTheDocument();
    expect(screen.getByText(/シールが 2まい/)).toBeInTheDocument();
  });

  it("「いま おてつだいする」で呼び出し元に知らせる", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    const onStart = vi.fn();
    renderScreen(<BonusBanner onStart={onStart} />);

    await userEvent.click(await screen.findByRole("button", { name: "いま おてつだいする" }));

    expect(onStart).toHaveBeenCalled();
  });

  it("onStart が無ければボタンを出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "いま おてつだいする" })).toBeNull();
  });
});

describe("おしらせのボタン", () => {
  it("Push に対応していない端末には出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.mocked(canUsePush).mockReturnValue(false);
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "おしらせを うけとる" })).toBeNull();
  });

  it("未許可なら出す", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    renderScreen(<BonusBanner />);

    await userEvent.click(await screen.findByRole("button", { name: "おしらせを うけとる" }));

    expect(subscribeToPush).toHaveBeenCalled();
  });

  it("許可ずみなら出さない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.mocked(pushPermission).mockReturnValue("granted");
    renderScreen(<BonusBanner />);

    await screen.findByText("きょうは ポイント2ばい デー！");
    expect(screen.queryByRole("button", { name: "おしらせを うけとる" })).toBeNull();
  });

  it("購読に失敗しても、握りつぶしてボタンを消す(押しっぱなしにさせない)", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap({ bonusToday: ON }));
    vi.mocked(subscribeToPush).mockRejectedValue(new Error("subscribe failed"));
    const onUnhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    try {
      renderScreen(<BonusBanner />);
      await userEvent.click(await screen.findByRole("button", { name: "おしらせを うけとる" }));

      expect(screen.queryByRole("button", { name: "おしらせを うけとる" })).toBeNull();
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  });
});
