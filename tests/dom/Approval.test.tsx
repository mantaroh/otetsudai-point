import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse, GrantResponse } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      grant: vi.fn(),
      approveGrant: vi.fn(),
      revokeGrant: vi.fn(),
      history: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api } from "../../src/client/api";
import { LedgerScreen } from "../../src/client/screens/Ledger";
import { ParentScreen } from "../../src/client/screens/Parent";
import {
  CHORE_BATH,
  HANA,
  makeBootstrap,
  makeGrant,
  makeRequest,
  makeSheet,
  renderScreen,
} from "./helpers";

/**
 * 承認あり運用(require_approval = 1)の画面。
 *
 * うちでは使わないが、他家庭では要求されるはずの設定。
 * 設定を ON にできるのに承認する手段が無い、という状態にしないための押さえ。
 */

let state: BootstrapResponse;

function approvalState(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return makeBootstrap({
    settings: {
      capacity: 5,
      requireApproval: true,
      allowSelfGrant: true,
      selfRevokeSec: 300,
      siblingsVisible: true,
      stickerTheme: "default",
      uiLogDays: 90,
    },
    sheets: { [HANA.id]: makeSheet({ stickers: [] }) },
    ...overrides,
  });
}

beforeEach(() => {
  state = approvalState();
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
  vi.mocked(api.history).mockResolvedValue([]);
});

describe("子の台帳(承認あり運用)", () => {
  async function openLedger() {
    const user = userEvent.setup();
    renderScreen(<LedgerScreen memberId={HANA.id} />);
    await screen.findByText("はなのだいちょう");
    return user;
  }

  it("ボタンが「おねがいする」になる", async () => {
    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));

    expect(screen.getByRole("button", { name: "おねがいする" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "シールをはる" })).not.toBeInTheDocument();
  });

  /**
   * 承認あり運用でシールが貼られたように見えてしまうと、
   * 直後に消えることになる。いちばん残念な体験なので、貼らない。
   */
  it("押しても台帳は増えず、おねがいしたことが分かる", async () => {
    vi.mocked(api.grant).mockImplementation(async () => {
      state = approvalState({ pendingGrants: [makeRequest({ id: "grt_new" })] });
      return { grant: makeRequest({ id: "grt_new" }), sheets: [], becameFull: false } as GrantResponse;
    });

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    await user.click(screen.getByRole("button", { name: "おねがいする" }));

    await waitFor(() =>
      expect(screen.getByText(/「おふろそうじ」を おうちの人に おねがいしたよ/)).toBeInTheDocument(),
    );
    expect(screen.queryAllByTestId("sticker")).toHaveLength(0);
    expect(screen.getByText("あと 5 まい")).toBeInTheDocument();
  });

  it("おうちの人まちの一覧が出る", async () => {
    state = approvalState({
      pendingGrants: [
        makeRequest({ id: "grt_1", choreLabel: "おふろそうじ", count: 1 }),
        makeRequest({ id: "grt_2", choreLabel: "ゴミすて", count: 2 }),
      ],
    });

    await openLedger();

    // お手伝いメニューにも同じ名前が並ぶので、待ちの欄の中だけを見る
    const queue = screen.getByText("おうちの人まち(2)").closest("section")!;
    expect(within(queue).getByText("おふろそうじ")).toBeInTheDocument();
    expect(within(queue).getByText("ゴミすて")).toBeInTheDocument();
    expect(within(queue).getByText("2まい")).toBeInTheDocument();
  });

  it("承認なしの家庭では、おうちの人まちは出ない", async () => {
    state = makeBootstrap({ sheets: { [HANA.id]: makeSheet({ stickers: [] }) } });
    await openLedger();
    expect(screen.queryByText(/おうちの人まち/)).not.toBeInTheDocument();
  });
});

describe("親の承認待ち一覧", () => {
  async function openParent() {
    const user = userEvent.setup();
    renderScreen(<ParentScreen />);
    await screen.findByText("おうちの人のがめん");
    return user;
  }

  it("申請が無ければ、しんせいちゅうの欄は出ない", async () => {
    await openParent();
    expect(screen.queryByText("しんせいちゅう")).not.toBeInTheDocument();
  });

  it("誰が何を何枚おねがいしたかが出る", async () => {
    state = approvalState({
      pendingGrants: [makeRequest({ id: "grt_1", choreLabel: "おふろそうじ", count: 3 })],
    });

    await openParent();
    expect(screen.getByText("しんせいちゅう")).toBeInTheDocument();
    expect(screen.getByText(/はな ・ おふろそうじ/)).toBeInTheDocument();
    expect(screen.getByText(/3まい/)).toBeInTheDocument();
  });

  it("OK を押すと承認される", async () => {
    state = approvalState({ pendingGrants: [makeRequest({ id: "grt_1" })] });
    vi.mocked(api.approveGrant).mockResolvedValue({
      grant: makeGrant({ id: "grt_1" }),
      sheets: [],
      becameFull: false,
    });

    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.approveGrant).toHaveBeenCalledWith("grt_1", undefined));
    expect(api.revokeGrant).not.toHaveBeenCalled();
  });

  it("ことわる を押すと取り消される", async () => {
    state = approvalState({ pendingGrants: [makeRequest({ id: "grt_1" })] });
    vi.mocked(api.revokeGrant).mockResolvedValue({ grant: makeGrant(), sheets: [] });

    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "ことわる" }));

    await waitFor(() => expect(api.revokeGrant).toHaveBeenCalledWith("grt_1", undefined, undefined));
    expect(api.approveGrant).not.toHaveBeenCalled();
  });

  it("PIN を求められたら、テンキーを通してから承認される", async () => {
    state = approvalState({ pendingGrants: [makeRequest({ id: "grt_1" })] });
    const { PinRequiredError } = await import("../../src/client/api");
    vi.mocked(api.approveGrant).mockImplementation(async (_id, pin) => {
      if (!pin) throw new PinRequiredError(401, "pin_required", "親の PIN が必要です");
      return { grant: makeGrant(), sheets: [], becameFull: false };
    });
    vi.mocked(api.verifyPin).mockResolvedValue({ ok: true });

    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("おうちの人のPIN")).toBeInTheDocument();
    for (const digit of "1234") {
      await user.click(screen.getByRole("button", { name: digit }));
    }
    // テンキーの OK と、承認の OK が同時に存在する
    await user.click(screen.getAllByRole("button", { name: "OK" })[1]!);

    await waitFor(() => expect(api.approveGrant).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.approveGrant).mock.calls[1]![1]).toBe("1234");
  });

  it("失敗したら理由が出る", async () => {
    state = approvalState({ pendingGrants: [makeRequest({ id: "grt_1" })] });
    vi.mocked(api.approveGrant).mockRejectedValue(new Error("取り消し済みの記録は承認できません"));

    const user = await openParent();
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("取り消し済みの記録は承認できません")).toBeInTheDocument();
  });
});

describe("だれ? の画面", () => {
  it("申請が溜まっていることが、親のボタンから分かる", async () => {
    state = approvalState({
      pendingGrants: [makeRequest({ id: "grt_1" }), makeRequest({ id: "grt_2" })],
    });

    const { HomeScreen } = await import("../../src/client/screens/Home");
    renderScreen(<HomeScreen />);

    expect(await screen.findByText("しんせいちゅう 2")).toBeInTheDocument();
  });
});

/** 承認あり運用でも、選べるお手伝いの見え方は変わらない */
describe("お手伝いの選択", () => {
  it("メニューはそのまま出る", async () => {
    renderScreen(<LedgerScreen memberId={HANA.id} />);
    await screen.findByText("はなのだいちょう");
    expect(screen.getByRole("button", { name: new RegExp(CHORE_BATH.name) })).toBeInTheDocument();
  });
});
