import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse, Grant } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      history: vi.fn(),
      redeem: vi.fn(),
      revokeGrant: vi.fn(),
      verifyPin: vi.fn(),
      createInvite: vi.fn(),
      updateSettings: vi.fn(),
      signOut: vi.fn(),
    },
  };
});

import { api, PinRequiredError } from "../../src/client/api";
import { ParentScreen } from "../../src/client/screens/Parent";
import { HANA, TARO, makeBootstrap, makeSheet, makeStickers, renderScreen } from "./helpers";

/** おうちの人の画面。交換のハンコと、シールの取り消しが本体。 */

let state: BootstrapResponse;

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "grt_1",
    memberId: HANA.id,
    choreId: "cho_bath",
    choreLabel: "おふろそうじ",
    choreEmoji: "🛁",
    count: 2,
    baseCount: 2,
    multiplier: 1,
    note: null,
    createdBy: HANA.id,
    createdByName: "はな",
    createdVia: "self",
    createdAt: Date.UTC(2026, 7, 1, 9, 0),
    approvedAt: 1,
    revokedAt: null,
    revokeReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  state = makeBootstrap({
    sheets: {
      [HANA.id]: makeSheet({ memberId: HANA.id }),
      [TARO.id]: makeSheet({ id: "sht_2", memberId: TARO.id, stickers: makeStickers(1) }),
    },
  });
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
  vi.mocked(api.history).mockResolvedValue([]);
});

async function openParent() {
  const user = userEvent.setup();
  renderScreen(<ParentScreen />);
  await screen.findByText("おうちの人のがめん");
  return user;
}

describe("だいちょうタブ", () => {
  it("子どもごとの進み具合が出る", async () => {
    await openParent();
    expect(screen.getByText("3 / 5 まい", { exact: false })).toBeInTheDocument();
  });

  it("いっぱいになっていない台帳には、ハンコのボタンが出ない", async () => {
    await openParent();
    expect(screen.queryByRole("button", { name: /ハンコをおして交換する/ })).not.toBeInTheDocument();
  });

  it("いっぱいなら、ハンコのボタンが出る", async () => {
    state = makeBootstrap({
      sheets: {
        [HANA.id]: makeSheet({ status: "full", stickers: makeStickers(5), filledAt: 2 }),
      },
    });
    await openParent();
    expect(screen.getByRole("button", { name: /ハンコをおして交換する/ })).toBeInTheDocument();
  });

  it("子からリクエストが来ていることが分かる", async () => {
    state = makeBootstrap({
      sheets: {
        [HANA.id]: makeSheet({
          status: "full",
          stickers: makeStickers(5),
          filledAt: 2,
          redeemRequestedAt: 3,
        }),
      },
    });
    await openParent();
    expect(screen.getByRole("button", { name: /リクエストあり/ })).toBeInTheDocument();
  });
});

describe("交換のハンコ", () => {
  beforeEach(() => {
    state = makeBootstrap({
      sheets: {
        [HANA.id]: makeSheet({ status: "full", stickers: makeStickers(5), filledAt: 2 }),
      },
    });
  });

  async function openDialog() {
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: /ハンコをおして交換する/ }));
    await screen.findByText(/はなの1さつめを交換/);
    return user;
  }

  it("交換したものを書かないと押せない", async () => {
    await openDialog();
    expect(screen.getByRole("button", { name: "ハンコをおす" })).toBeDisabled();
  });

  it("交換したものとカテゴリを記録する", async () => {
    vi.mocked(api.redeem).mockResolvedValue({ sheet: makeSheet(), nextSheet: null });
    const user = await openDialog();

    await user.type(screen.getByPlaceholderText(/Robux/), "Robux 1200");
    await user.click(screen.getByRole("button", { name: "Roblox" }));
    await user.type(screen.getByPlaceholderText("金額(任意)"), "1500");
    await user.click(screen.getByRole("button", { name: "ハンコをおす" }));

    await waitFor(() =>
      expect(api.redeem).toHaveBeenCalledWith(
        "sht_1",
        { rewardText: "Robux 1200", category: "roblox", amountYen: 1500 },
        undefined,
      ),
    );
  });

  it("カテゴリも金額も任意(用途を縛らない運用に合わせる)", async () => {
    vi.mocked(api.redeem).mockResolvedValue({ sheet: makeSheet(), nextSheet: null });
    const user = await openDialog();

    await user.type(screen.getByPlaceholderText(/Robux/), "まんが");
    await user.click(screen.getByRole("button", { name: "ハンコをおす" }));

    await waitFor(() =>
      expect(api.redeem).toHaveBeenCalledWith(
        "sht_1",
        { rewardText: "まんが", category: undefined, amountYen: undefined },
        undefined,
      ),
    );
  });

  it("PIN を求められたらテンキーが出て、通ったらもう一度送られる", async () => {
    vi.mocked(api.redeem).mockImplementation(async (_sheetId, _body, pin) => {
      if (!pin) throw new PinRequiredError(401, "pin_required", "親の PIN が必要です");
      return { sheet: makeSheet(), nextSheet: null };
    });
    vi.mocked(api.verifyPin).mockResolvedValue({ ok: true });

    const user = await openDialog();
    await user.type(screen.getByPlaceholderText(/Robux/), "まんが");
    await user.click(screen.getByRole("button", { name: "ハンコをおす" }));

    expect(await screen.findByText("おうちの人のPIN")).toBeInTheDocument();
    for (const digit of "1234") {
      await user.click(screen.getByRole("button", { name: digit }));
    }
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.redeem).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.redeem).mock.calls[1]![2]).toBe("1234");
  });
});

describe("りれきタブ", () => {
  it("誰がいつ何を何枚貼ったかが出る", async () => {
    vi.mocked(api.history).mockResolvedValue([grant()]);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    expect(await screen.findByText(/はな ・ おふろそうじ/)).toBeInTheDocument();
    expect(screen.getByText(/2まい/)).toBeInTheDocument();
    expect(screen.getByText(/じぶんで/)).toBeInTheDocument();
  });

  it("親がつけたぶんは、誰がつけたか分かる", async () => {
    vi.mocked(api.history).mockResolvedValue([
      grant({ createdVia: "parent", createdBy: "mem_parent", createdByName: "おとうさん" }),
    ]);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    expect(await screen.findByText(/おとうさんがつけた/)).toBeInTheDocument();
  });

  it("取り消せる", async () => {
    vi.mocked(api.history).mockResolvedValue([grant()]);
    vi.mocked(api.revokeGrant).mockResolvedValue({ grant: grant(), sheets: [] });
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    await user.click(await screen.findByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(api.revokeGrant).toHaveBeenCalledWith("grt_1", undefined, undefined));
  });

  it("確認を取り消したら、シールは消えない", async () => {
    vi.mocked(api.history).mockResolvedValue([grant()]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    await user.click(await screen.findByRole("button", { name: "取り消す" }));
    expect(api.revokeGrant).not.toHaveBeenCalled();
  });

  it("取り消しずみの記録は残るが、もう取り消せない", async () => {
    vi.mocked(api.history).mockResolvedValue([grant({ revokedAt: Date.now() })]);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    expect(await screen.findByText("取り消し")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();
  });

  it("2倍で貼られたシールにはバッジが出る", async () => {
    vi.mocked(api.history).mockResolvedValue([
      grant({ id: "grt_bonus", count: 6, baseCount: 3, multiplier: 2 }),
    ]);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    expect(await screen.findByText(/6まい/)).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  it("ふつうの日はバッジが出ない", async () => {
    vi.mocked(api.history).mockResolvedValue([grant({ count: 1 })]);
    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "りれき" }));

    await screen.findByText(/1まい/);
    expect(screen.queryByText("×2")).toBeNull();
  });
});
// せっていタブの中身は tests/dom/Settings.test.tsx で扱う
