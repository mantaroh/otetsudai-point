import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse, GrantResponse, UiEventBatch } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      grant: vi.fn(),
      revokeGrant: vi.fn(),
      requestRedeem: vi.fn(),
      addChore: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api } from "../../src/client/api";
import { flush, startTelemetry } from "../../src/client/lib/telemetry";
import { LedgerScreen } from "../../src/client/screens/Ledger";
import {
  CHORE_BATH,
  CHORE_WALK,
  HANA,
  makeBootstrap,
  makeSheet,
  makeStickers,
  renderScreen,
} from "./helpers";

/**
 * 台帳の画面。子供が一番よく触るところなので、
 * 「押した瞬間に貼られて見える」「押した回数だけ貼られる」を重点的に押さえる。
 */

let state: BootstrapResponse;

/** サーバがシールを1枚受け付けた、という状態にする */
function serverAddsSticker(art: string | null) {
  const sheet = state.sheets[HANA.id]!;
  const next = [
    ...sheet.stickers,
    {
      id: `stk_new_${sheet.stickers.length + 1}`,
      grantId: `grt_new_${sheet.stickers.length + 1}`,
      position: sheet.stickers.length + 1,
      art,
      createdAt: Date.now(),
    },
  ];
  state = {
    ...state,
    sheets: {
      ...state.sheets,
      [HANA.id]: {
        ...sheet,
        stickers: next,
        filled: next.length,
        status: next.length >= sheet.capacity ? "full" : "active",
      },
    },
  };
}

function grantResponse(id: string, becameFull = false): GrantResponse {
  return {
    grant: {
      id,
      memberId: HANA.id,
      choreId: CHORE_BATH.id,
      choreLabel: CHORE_BATH.name,
      choreEmoji: CHORE_BATH.emoji,
      count: 1,
      baseCount: 1,
      multiplier: 1,
      note: null,
      createdBy: HANA.id,
      createdByName: HANA.name,
      createdVia: "self",
      createdAt: Date.now(),
      approvedAt: Date.now(),
      revokedAt: null,
      revokeReason: null,
    },
    sheets: [],
    becameFull,
  };
}

beforeEach(() => {
  state = makeBootstrap();
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
});

const stickers = () => screen.queryAllByTestId("sticker");
const emptySlots = () => screen.queryAllByTestId("empty-slot");

async function openLedger() {
  const user = userEvent.setup();
  renderScreen(<LedgerScreen memberId={HANA.id} />);
  await screen.findByText("はなのだいちょう");
  return user;
}

describe("台帳の表示", () => {
  it("貼られたシールと空きマスが、マス数どおりに並ぶ", async () => {
    await openLedger();
    expect(stickers()).toHaveLength(3);
    expect(emptySlots()).toHaveLength(2);
  });

  it("残り枚数が出る", async () => {
    await openLedger();
    expect(screen.getByText("あと 2 まい")).toBeInTheDocument();
  });

  it("何冊目かと進み具合が出る", async () => {
    await openLedger();
    expect(screen.getByText(/1さつめ/)).toHaveTextContent("3 / 5");
  });

  it("シールにはお手伝いの絵文字が乗る", async () => {
    await openLedger();
    expect(stickers()[0]).toHaveTextContent("🛁");
  });
});

describe("シールを貼る", () => {
  it("お手伝いを選ぶと、シールを貼るボタンが出る", async () => {
    const user = await openLedger();
    expect(screen.queryByRole("button", { name: "シールをはる" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    expect(screen.getByRole("button", { name: "シールをはる" })).toBeInTheDocument();
  });

  it("通信を待たずに、押した瞬間マスが埋まる", async () => {
    let release: (value: GrantResponse) => void = () => {};
    vi.mocked(api.grant).mockImplementation(
      () =>
        new Promise<GrantResponse>((resolve) => {
          release = resolve;
        }),
    );

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    await user.click(screen.getByRole("button", { name: "シールをはる" }));

    // まだサーバは返していないのに、もう貼られて見えている
    expect(stickers()).toHaveLength(4);
    expect(screen.getByText("あと 1 まい")).toBeInTheDocument();

    serverAddsSticker(CHORE_BATH.emoji);
    release(grantResponse("grt_1"));
    await waitFor(() => expect(stickers()).toHaveLength(4));
  });

  it("押した回数だけ貼られる", async () => {
    vi.mocked(api.grant).mockImplementation(async () => {
      serverAddsSticker(CHORE_BATH.emoji);
      return grantResponse(`grt_${Date.now()}`);
    });

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));

    const stick = screen.getByRole("button", { name: "シールをはる" });
    await user.click(stick);
    await user.click(stick);

    await waitFor(() => expect(stickers()).toHaveLength(5));
    expect(api.grant).toHaveBeenCalledTimes(2);
  });

  it("連打しても requestId が毎回ちがう(サーバ側で1件にまとめられてしまわない)", async () => {
    vi.mocked(api.grant).mockImplementation(async () => grantResponse("grt_x"));

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    const stick = screen.getByRole("button", { name: "シールをはる" });
    await user.click(stick);
    await user.click(stick);

    const requestIds = vi.mocked(api.grant).mock.calls.map(([body]) => body.requestId);
    expect(new Set(requestIds).size).toBe(2);
  });

  it("めやす枚数のあるお手伝いは、まとめて貼れる", async () => {
    vi.mocked(api.grant).mockImplementation(async () => grantResponse("grt_1"));

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /いぬのさんぽ/ }));
    await user.click(screen.getByRole("button", { name: "まとめて 3 まい" }));

    expect(api.grant).toHaveBeenCalledWith(
      expect.objectContaining({ choreId: CHORE_WALK.id, count: 3 }),
    );
  });

  it("失敗したら、貼られて見えていたシールが戻る", async () => {
    vi.mocked(api.grant).mockRejectedValue(new Error("つうしんに しっぱいしました"));

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    await user.click(screen.getByRole("button", { name: "シールをはる" }));

    await waitFor(() => expect(screen.getByText("つうしんに しっぱいしました")).toBeInTheDocument());
    expect(stickers()).toHaveLength(3);
  });
});

describe("1まいもどす", () => {
  it("貼るまでは押せない", async () => {
    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    expect(screen.getByRole("button", { name: "1まいもどす" })).toBeDisabled();
  });

  it("直前に貼ったシールを取り消す", async () => {
    vi.mocked(api.grant).mockImplementation(async () => grantResponse("grt_last"));
    vi.mocked(api.revokeGrant).mockResolvedValue({ grant: {} as never, sheets: [] });

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    await user.click(screen.getByRole("button", { name: "シールをはる" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "1まいもどす" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "1まいもどす" }));

    await waitFor(() =>
      expect(api.revokeGrant).toHaveBeenCalledWith("grt_last", undefined, undefined),
    );
  });
});

describe("そのほか(自由入力)", () => {
  it("入力したお手伝いをメニューに追加して、そのまま選んだ状態になる", async () => {
    const created = {
      id: "cho_new",
      name: "ねこのトイレそうじ",
      emoji: "🧹",
      defaultCount: 1,
      useCount: 0,
      lastUsedAt: null,
    };
    vi.mocked(api.addChore).mockResolvedValue(created);

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /そのほか/ }));
    await user.click(screen.getByRole("button", { name: "🧹" }));
    await user.type(screen.getByPlaceholderText("なにをした?"), "ねこのトイレそうじ");
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.addChore).toHaveBeenCalledWith("ねこのトイレそうじ", "🧹"));
    expect(await screen.findByRole("button", { name: "シールをはる" })).toBeInTheDocument();
  });

  it("空のままでは追加できない", async () => {
    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: /そのほか/ }));
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });
});

describe("台帳がいっぱいになったとき", () => {
  it("こうかんしたい! が出る", async () => {
    state = makeBootstrap({
      sheets: {
        [HANA.id]: makeSheet({ status: "full", stickers: makeStickers(5), filledAt: 2 }),
      },
    });

    await openLedger();
    expect(screen.getByText("いっぱいになったよ!")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "こうかんしたい!" })).toBeInTheDocument();
    expect(emptySlots()).toHaveLength(0);
  });

  it("押すと、親へのリクエストが飛ぶ", async () => {
    state = makeBootstrap({
      sheets: {
        [HANA.id]: makeSheet({ status: "full", stickers: makeStickers(5), filledAt: 2 }),
      },
    });
    vi.mocked(api.requestRedeem).mockResolvedValue(makeSheet());

    const user = await openLedger();
    await user.click(screen.getByRole("button", { name: "こうかんしたい!" }));
    await waitFor(() => expect(api.requestRedeem).toHaveBeenCalledWith("sht_1"));
  });

  it("繰り越したあとも、満了した台帳を交換できる", async () => {
    // 1冊目が満了して、2冊目にもう2枚貼ってある状態。
    // ここで1冊目が画面から消えると、渡す前の台帳が交換できなくなる。
    const full = makeSheet({
      id: "sht_1",
      seqNo: 1,
      status: "full",
      stickers: makeStickers(5),
      filledAt: 2,
    });
    const next = makeSheet({ id: "sht_2", seqNo: 2, stickers: makeStickers(2) });
    state = makeBootstrap({ sheets: { [HANA.id]: next }, pendingSheets: [full] });
    vi.mocked(api.requestRedeem).mockResolvedValue(full);

    const user = await openLedger();

    // いま貼れるのは2冊目
    expect(screen.getByText(/2さつめ/)).toHaveTextContent("2 / 5");
    expect(stickers()).toHaveLength(2);

    // 1冊目は交換できる状態として、ちゃんと出ている
    const button = screen.getByRole("button", { name: "1さつめこうかんしたい!" });
    await user.click(button);
    await waitFor(() => expect(api.requestRedeem).toHaveBeenCalledWith("sht_1"));
  });

  it("リクエスト済みなら、待っている状態が出る", async () => {
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

    await openLedger();
    expect(screen.getByText(/おうちの人にわたしたよ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "こうかんしたい!" })).not.toBeInTheDocument();
  });
});

/**
 * 30枚たまるのがこの台帳のゴール。
 * そこに届いた瞬間を記録していないと、到達回数も「1枚目から何日かかったか」も出せない。
 */
describe("台帳が満了したとき", () => {
  it("満了したことと、1枚目からの日数を記録する", async () => {
    const sent: UiEventBatch[] = [];
    const stopTelemetry = startTelemetry({ send: (batch) => sent.push(batch) });

    try {
      const filled = makeSheet({
        status: "full",
        startedAt: Date.now() - 12 * 86_400_000,
        filledAt: Date.now(),
      });
      vi.mocked(api.grant).mockImplementation(async () => ({
        ...grantResponse("grt_full", true),
        sheets: [filled],
      }));

      const user = await openLedger();
      await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
      await user.click(screen.getByRole("button", { name: "シールをはる" }));

      await waitFor(() => {
        flush();
        expect(sent.flatMap((batch) => batch.events)).toContainEqual(
          expect.objectContaining({ type: "flow", name: "sheet-full", value: 12 }),
        );
      });
    } finally {
      stopTelemetry();
    }
  });
});
