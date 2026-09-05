import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BonusRule, BonusState } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      bonus: vi.fn(),
      enableBonusToday: vi.fn(),
      disableBonusToday: vi.fn(),
      addBonusRule: vi.fn(),
      removeBonusRule: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api } from "../../src/client/api";
import { SettingsTab } from "../../src/client/screens/ParentSettings";
import { makeBootstrap, renderScreen } from "./helpers";

const OFF: BonusState = { active: false, multiplier: 1, source: "none", dayKey: "2026-09-05" };
const ON_ONCE: BonusState = { active: true, multiplier: 2, source: "once", dayKey: "2026-09-05" };
const ON_WEEKLY: BonusState = { active: true, multiplier: 2, source: "weekly", dayKey: "2026-09-06" };

const SUNDAY_RULE: BonusRule = {
  id: "bns_sun",
  kind: "weekly",
  onDate: null,
  weekday: 0,
  dayOfMonth: null,
  multiplier: 2,
  createdAt: 1,
};

beforeEach(() => {
  vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());
  vi.mocked(api.bonus).mockResolvedValue({ state: OFF, rules: [] });
  vi.mocked(api.enableBonusToday).mockResolvedValue({ state: ON_ONCE, notified: true });
  vi.mocked(api.disableBonusToday).mockResolvedValue({ state: OFF });
  vi.mocked(api.addBonusRule).mockResolvedValue({ rule: SUNDAY_RULE });
  vi.mocked(api.removeBonusRule).mockResolvedValue({ ok: true });
});

describe("ポイント2倍デーの設定", () => {
  it("今日を2倍にできる", async () => {
    renderScreen(<SettingsTab />);
    const button = await screen.findByRole("button", { name: /今日をポイント2倍にする/ });

    await userEvent.click(button);

    await waitFor(() => expect(api.enableBonusToday).toHaveBeenCalled());
    expect(await screen.findByText(/今日はポイント2倍/)).toBeInTheDocument();
  });

  it("定期ルールで2倍の日は、理由を出して押せなくする", async () => {
    vi.mocked(api.bonus).mockResolvedValue({ state: ON_WEEKLY, rules: [SUNDAY_RULE] });
    renderScreen(<SettingsTab />);

    expect(await screen.findByText(/毎週日曜日の設定で2倍/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /今日の2倍をやめる/ })).toBeNull();
  });

  it("毎週の曜日を追加できる", async () => {
    renderScreen(<SettingsTab />);
    const sunday = await screen.findByRole("button", { name: "毎週 日曜日" });

    await userEvent.click(sunday);

    await waitFor(() =>
      expect(api.addBonusRule).toHaveBeenCalledWith({ kind: "weekly", weekday: 0 }, undefined),
    );
  });

  it("毎月の日にちを追加できる", async () => {
    renderScreen(<SettingsTab />);
    const input = await screen.findByLabelText("毎月の日にち");

    await userEvent.type(input, "9");
    await userEvent.click(screen.getByRole("button", { name: "毎月の日を追加" }));

    await waitFor(() =>
      expect(api.addBonusRule).toHaveBeenCalledWith({ kind: "monthly", dayOfMonth: 9 }, undefined),
    );
  });

  it("登録ずみのルールを消せる", async () => {
    vi.mocked(api.bonus).mockResolvedValue({ state: OFF, rules: [SUNDAY_RULE] });
    renderScreen(<SettingsTab />);

    await userEvent.click(await screen.findByRole("button", { name: "毎週日曜日 を削除" }));

    await waitFor(() => expect(api.removeBonusRule).toHaveBeenCalledWith("bns_sun", undefined));
  });
});
