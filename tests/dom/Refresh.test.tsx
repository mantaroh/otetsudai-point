import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      me: vi.fn(),
      createFamily: vi.fn(),
      grant: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { ApiError, api } from "../../src/client/api";
import { App } from "../../src/client/App";
import { bootstrapKey } from "../../src/client/hooks";
import { HANA, makeBootstrap, makeSheet, makeStickers, renderScreen } from "./helpers";

/**
 * 裏での再取得が、画面を作り直してしまわないこと。
 *
 * デプロイ後に「はじめの設定を入力していると、15秒ごとに内容が消える」という形で出た不具合。
 * bootstrap の定期再取得が失敗するたび、App が読み込み中の表示に切り替わり、
 * その下の画面ごと React に捨てられていた。
 */

const unauthorized = () => new ApiError(401, "unauthorized", "ログインが必要です");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("はじめの設定", () => {
  beforeEach(() => {
    vi.mocked(api.bootstrap).mockRejectedValue(unauthorized());
    vi.mocked(api.me).mockResolvedValue({
      user: { id: "usr_1", displayName: "おとうさん", email: "a@example.com" },
      families: [],
      currentFamilyId: null,
    });
  });

  it("入力している最中に裏で再取得が起きても、入力が消えない", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderScreen(<App />);

    await screen.findByRole("heading", { name: "はじめの設定" });
    await user.type(screen.getByPlaceholderText("やまだ家"), "やまだ家");
    await user.type(screen.getByPlaceholderText("1人目の名前"), "はな");

    // 定期再取得と同じことを起こす(結果はまた 401)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: bootstrapKey });
    });

    expect(screen.getByPlaceholderText("やまだ家")).toHaveValue("やまだ家");
    expect(screen.getByPlaceholderText("1人目の名前")).toHaveValue("はな");
    expect(screen.getByRole("heading", { name: "はじめの設定" })).toBeInTheDocument();
  });

  it("何度再取得しても、読み込み中の表示に戻らない", async () => {
    const { queryClient } = renderScreen(<App />);
    await screen.findByRole("heading", { name: "はじめの設定" });

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: bootstrapKey });
      });
      expect(screen.getByRole("heading", { name: "はじめの設定" })).toBeInTheDocument();
    }
  });

  /** 未ログインのあいだは、更新すべき台帳がそもそも無い */
  it("取れていないあいだは、定期再取得をしない", async () => {
    const { queryClient } = renderScreen(<App />);
    await screen.findByRole("heading", { name: "はじめの設定" });

    const query = queryClient.getQueryCache().find({ queryKey: bootstrapKey })!;
    const options = query.options as {
      refetchInterval?: unknown;
      refetchOnWindowFocus?: unknown;
    };

    expect(typeof options.refetchInterval).toBe("function");
    expect((options.refetchInterval as (q: unknown) => unknown)(query)).toBe(false);
    expect((options.refetchOnWindowFocus as (q: unknown) => unknown)(query)).toBe(false);
  });
});

describe("台帳を開いているとき", () => {
  it("裏で再取得が起きても、選んだお手伝いが解除されない", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(
      makeBootstrap({ sheets: { [HANA.id]: makeSheet({ stickers: makeStickers(2) }) } }),
    );
    window.history.replaceState(null, "", `/m/${HANA.id}`);

    const user = userEvent.setup();
    const { queryClient } = renderScreen(<App />);

    await screen.findByRole("heading", { name: "はなのだいちょう" });
    await user.click(screen.getByRole("button", { name: /おふろそうじ/ }));
    expect(screen.getByRole("button", { name: "シールをはる" })).toBeInTheDocument();

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: bootstrapKey });
    });

    // 選んだ状態のまま。ここが外れると、貼っている途中で選び直しになる
    expect(screen.getByRole("button", { name: "シールをはる" })).toBeInTheDocument();
  });

  /** 取れたあとは、他の端末で貼られたぶんを拾うために定期再取得する */
  it("取れたあとは、定期再取得が有効になる", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());

    const { queryClient } = renderScreen(<App />);
    await screen.findByText("やまだ家");

    const query = queryClient.getQueryCache().find({ queryKey: bootstrapKey })!;
    const options = query.options as { refetchInterval?: unknown; refetchOnWindowFocus?: unknown };

    expect((options.refetchInterval as (q: unknown) => unknown)(query)).toBe(15_000);
    expect((options.refetchOnWindowFocus as (q: unknown) => unknown)(query)).toBe(true);
  });
});

describe("ログアウトなどで見えなくなったとき", () => {
  it("古い画面を出し続けず、サインインに戻る", async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(makeBootstrap());
    vi.mocked(api.me).mockRejectedValue(unauthorized());

    const { queryClient } = renderScreen(<App />);
    await screen.findByText("やまだ家");

    // ここでログアウトされた、という状況
    vi.mocked(api.bootstrap).mockRejectedValue(unauthorized());
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: bootstrapKey });
    });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Google でログイン/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText("やまだ家")).not.toBeInTheDocument();
  });
});
