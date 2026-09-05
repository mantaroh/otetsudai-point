import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return { ...actual, api: { bootstrap: vi.fn() } };
});

import { api } from "../../src/client/api";
import { HomeScreen } from "../../src/client/screens/Home";
import { HANA, TARO, makeBootstrap, makeSheet, makeStickers, renderScreen } from "./helpers";

/** 共有タブレットの入口。顔を選ぶだけで台帳に入れることを確かめる。 */

let state: BootstrapResponse;

function bothChildren(overrides: Parameters<typeof makeSheet>[0] = {}): BootstrapResponse {
  return makeBootstrap({
    sheets: {
      [HANA.id]: makeSheet({ memberId: HANA.id, ...overrides }),
      [TARO.id]: makeSheet({ id: "sht_2", memberId: TARO.id, stickers: makeStickers(1) }),
    },
  });
}

beforeEach(() => {
  state = bothChildren();
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
});

async function openHome() {
  const user = userEvent.setup();
  renderScreen(<HomeScreen />);
  await screen.findByText("はな");
  return user;
}

describe("だれ? の画面", () => {
  it("子どもだけが並ぶ(親は出ない)", async () => {
    await openHome();
    expect(screen.getByText("はな")).toBeInTheDocument();
    expect(screen.getByText("たろう")).toBeInTheDocument();
    expect(screen.queryByText("おとうさん")).not.toBeInTheDocument();
  });

  it("それぞれの進み具合が出る", async () => {
    await openHome();
    expect(screen.getByText("3 / 5 まい")).toBeInTheDocument();
    expect(screen.getByText("1 / 5 まい")).toBeInTheDocument();
  });

  it("顔を押すとその子の台帳へ移動する", async () => {
    const user = await openHome();
    await user.click(screen.getByRole("button", { name: /はな/ }));
    expect(window.location.pathname).toBe(`/m/${HANA.id}`);
  });

  it("台帳がいっぱいの子には、こうかんできる! が出る", async () => {
    state = bothChildren({ status: "full", stickers: makeStickers(5), filledAt: 2 });
    await openHome();
    expect(screen.getByText("こうかんできる!")).toBeInTheDocument();
  });

  it("交換待ちがあると、親の画面にバッジが出る", async () => {
    state = bothChildren({ status: "full", stickers: makeStickers(5), filledAt: 2 });
    await openHome();
    expect(screen.getByText("こうかんまち 1")).toBeInTheDocument();
  });

  it("交換待ちが無ければバッジは出ない", async () => {
    await openHome();
    expect(screen.queryByText(/こうかんまち/)).not.toBeInTheDocument();
  });
});
