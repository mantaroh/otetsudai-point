import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse, UiInsights } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      insights: vi.fn(),
      clearUiEvents: vi.fn(),
      updateSettings: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api, PinRequiredError } from "../../src/client/api";
import { InsightsTab } from "../../src/client/screens/ParentInsights";
import { HANA, makeBootstrap, renderScreen } from "./helpers";

/**
 * つかわれかたの画面。
 *
 * ここは「数字を出せているか」より、**その数字を見て手が動くか**が要点。
 * 記録の識別子(dead-tap, ledger)がそのまま並ぶだけでは、家庭の親には読めない。
 */

let state: BootstrapResponse;

function makeInsights(overrides: Partial<UiInsights> = {}): UiInsights {
  return {
    days: 30,
    from: Date.UTC(2026, 6, 18),
    retentionDays: 90,
    sessions: 12,
    events: 340,
    screens: [{ screen: "ledger", views: 20, sessions: 12, medianDwellMs: 45_000 }],
    actions: [
      { name: "stick", screen: null, detail: null, count: 87 },
      { name: "undo", screen: null, detail: null, count: 4 },
    ],
    frictions: [{ name: "dead-tap", screen: "ledger", detail: "sheet-grid", count: 18 }],
    errors: [],
    funnel: { opened: 20, picked: 18, stuck: 15 },
    firstSticker: { samples: 15, p50Ms: 12_300, p90Ms: 41_000, medianTaps: 3 },
    members: [
      {
        memberId: HANA.id,
        sessions: 8,
        sticks: 50,
        undos: 2,
        frictions: 9,
        medianFirstStickerMs: 9_000,
      },
    ],
    daily: [{ date: "2026-08-16", sessions: 3, sticks: 12 }],
    ...overrides,
  };
}

beforeEach(() => {
  state = makeBootstrap();
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
  vi.mocked(api.insights).mockResolvedValue(makeInsights());
});

describe("つかわれかた", () => {
  it("記録の識別子ではなく、日本語の名前で並ぶ", async () => {
    renderScreen(<InsightsTab />);

    expect(await screen.findByText("だいちょう")).toBeInTheDocument();
    expect(screen.getByText("シールを貼る")).toBeInTheDocument();
    expect(screen.queryByText("stick")).not.toBeInTheDocument();
    expect(screen.queryByText("ledger")).not.toBeInTheDocument();
  });

  /** 数字だけ出しても手は動かない。何を直せばいいかまで出す */
  it("つまずきには、どこで起きたかと、何を直すかが添えられる", async () => {
    renderScreen(<InsightsTab />);

    expect(
      await screen.findByText("反応しない場所をタップ(だいちょう / だいちょうのマス)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/押せると思って押されている。押せるようにするか/),
    ).toBeInTheDocument();
  });

  it("開いてから貼るまでの落ち方が出る", async () => {
    renderScreen(<InsightsTab />);

    await screen.findByText("だいちょうを開いてから貼るまで");
    expect(screen.getByText("お手伝いをえらんだ")).toBeInTheDocument();
    // 18 / 20
    expect(screen.getByText("(90%)")).toBeInTheDocument();
    // 1枚目までの中央値。ミリ秒のままでは読めない
    expect(screen.getAllByText("12.3秒").length).toBeGreaterThan(0);
    expect(screen.getByText("3回")).toBeInTheDocument();
  });

  it("子ごとの並びは、IDではなく名前で出る", async () => {
    renderScreen(<InsightsTab />);

    await screen.findByText("子ごと");
    expect(screen.getByText("はな")).toBeInTheDocument();
    expect(screen.queryByText(HANA.id)).not.toBeInTheDocument();
  });

  it("期間を変えると取り直す", async () => {
    const user = userEvent.setup();
    renderScreen(<InsightsTab />);
    await screen.findByText("ぜんたい");

    await user.click(screen.getByRole("button", { name: "7日" }));

    await waitFor(() => expect(api.insights).toHaveBeenCalledWith(7));
  });

  it("記録が無い期間は、そう言うだけにする", async () => {
    vi.mocked(api.insights).mockResolvedValue(
      makeInsights({ events: 0, sessions: 0, screens: [], actions: [], members: [], daily: [] }),
    );
    renderScreen(<InsightsTab />);

    expect(await screen.findByText("まだ記録がありません")).toBeInTheDocument();
  });
});

describe("記録のあつかい", () => {
  /**
   * 集めているものを、いつでも止められて、いつでも消せる。
   * 子どもの操作記録を持つ以上、これを設定の奥に隠さない。
   */
  it("同じ画面から、記録を止められる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateSettings).mockResolvedValue({ ...state.settings, uiLogDays: 0 });
    renderScreen(<InsightsTab />);

    await screen.findByText("記録のあつかい");
    await user.click(screen.getByRole("button", { name: "記録しない" }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ uiLogDays: 0 }, undefined),
    );
  });

  it("これまでの記録を消せる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clearUiEvents).mockResolvedValue({ ok: true, deleted: 340 });
    renderScreen(<InsightsTab />);

    await screen.findByText("記録のあつかい");
    await user.click(screen.getByRole("button", { name: "これまでの記録を消す" }));

    await waitFor(() => expect(api.clearUiEvents).toHaveBeenCalled());
    expect(await screen.findByText("消しました")).toBeInTheDocument();
  });

  it("消す前に確認する。やめたら何も起きない", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("confirm", () => false);
    renderScreen(<InsightsTab />);

    await screen.findByText("記録のあつかい");
    await user.click(screen.getByRole("button", { name: "これまでの記録を消す" }));

    expect(api.clearUiEvents).not.toHaveBeenCalled();
  });
});

describe("PIN", () => {
  /**
   * せっていと同じ扱い。タブを開いた瞬間にテンキーが出るのは唐突なので、
   * まず PIN なしで試して、断られたらボタンだけ出す。
   */
  it("開いた瞬間にはテンキーを出さない", async () => {
    vi.mocked(api.insights).mockRejectedValue(
      new PinRequiredError(401, "pin_required", "親の PIN が必要です"),
    );
    renderScreen(<InsightsTab />);

    expect(await screen.findByRole("button", { name: "見る" })).toBeInTheDocument();
    expect(screen.queryByText("おうちの人のPIN")).not.toBeInTheDocument();
  });

  it("「見る」を押すとテンキーが出て、通れば中身が出る", async () => {
    const user = userEvent.setup();
    // 一度 PIN が通れば、サーバが短命チケットを発行するので以後は PIN 無しで通る。
    // モックもその形にしておかないと、通したあとの取り直しが再び弾かれてしまう
    let unlocked = false;
    vi.mocked(api.insights).mockImplementation(async (_days, pin) => {
      if (pin) unlocked = true;
      if (!unlocked) throw new PinRequiredError(401, "pin_required", "親の PIN が必要です");
      return makeInsights();
    });
    vi.mocked(api.verifyPin).mockResolvedValue({ ok: true });
    renderScreen(<InsightsTab />);

    await user.click(await screen.findByRole("button", { name: "見る" }));
    await screen.findByText("おうちの人のPIN");

    for (const digit of "1234") await user.click(screen.getByRole("button", { name: digit }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("ぜんたい")).toBeInTheDocument();
  });
});
