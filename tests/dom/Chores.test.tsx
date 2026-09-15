import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse, Chore } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      addChore: vi.fn(),
      updateChore: vi.fn(),
      reorderChores: vi.fn(),
      // せってい画面の他の欄が呼ぶもの。この画面のテストでは中身を問わない
      bonus: vi.fn(),
      devices: vi.fn(),
      archivedMembers: vi.fn(),
      verifyPin: vi.fn(),
    },
  };
});

import { api, ApiError } from "../../src/client/api";
import { SettingsTab } from "../../src/client/screens/ParentSettings";
import { CHORE_BATH, CHORE_WALK, makeBootstrap, renderScreen } from "./helpers";

/**
 * お手伝いメニューの追加と並べ替え(親設定)。
 *
 * 並べた順がそのまま子どもの台帳のボタンの並びになる。
 * 並べ替えは画面に見えている並びを丸ごと送るので、「送った並びが正しいか」を中心に見る。
 */

const CHORE_DISH: Chore = {
  id: "cho_dish",
  name: "しょっきあらい",
  emoji: "🍽️",
  defaultCount: 1,
  useCount: 0,
  lastUsedAt: null,
  sortOrder: 2,
};

let state: BootstrapResponse;

beforeEach(() => {
  state = makeBootstrap({
    chores: [CHORE_BATH, CHORE_WALK, CHORE_DISH],
    auth: { kind: "user", lockedMemberId: null, canActAsParent: true, needsPin: false, userDisplayName: "おとうさん" },
  });
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
  vi.mocked(api.bonus).mockResolvedValue({
    state: { active: false, multiplier: 1, source: "none", dayKey: "2026-09-15" },
    rules: [],
  });
  vi.mocked(api.devices).mockResolvedValue([]);
  vi.mocked(api.archivedMembers).mockResolvedValue([]);
  vi.mocked(api.reorderChores).mockImplementation(async (choreIds: string[]) => {
    const byId = new Map(state.chores.map((chore) => [chore.id, chore]));
    state = { ...state, chores: choreIds.map((id, index) => ({ ...byId.get(id)!, sortOrder: index })) };
    return state.chores;
  });
});

describe("並べ替え", () => {
  it("↓ を押すと、1つ下と入れ替えた並びが送られる", async () => {
    renderScreen(<SettingsTab />);

    await userEvent.click(await screen.findByRole("button", { name: "おふろそうじ を下へ" }));

    await waitFor(() =>
      expect(api.reorderChores).toHaveBeenCalledWith(
        [CHORE_WALK.id, CHORE_BATH.id, CHORE_DISH.id],
        undefined,
      ),
    );
  });

  it("↑ を押すと、1つ上と入れ替えた並びが送られる", async () => {
    renderScreen(<SettingsTab />);

    await userEvent.click(await screen.findByRole("button", { name: "しょっきあらい を上へ" }));

    await waitFor(() =>
      expect(api.reorderChores).toHaveBeenCalledWith(
        [CHORE_BATH.id, CHORE_DISH.id, CHORE_WALK.id],
        undefined,
      ),
    );
  });

  it("並べ替えたあと、新しい並びで表示される", async () => {
    renderScreen(<SettingsTab />);

    await userEvent.click(await screen.findByRole("button", { name: "おふろそうじ を下へ" }));

    // 並べ替えのあとは、先頭のお手伝いの ↑ が押せなくなる
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "いぬのさんぽ を上へ" })).toBeDisabled(),
    );
  });

  it("一番上の ↑ と一番下の ↓ は押せない", async () => {
    renderScreen(<SettingsTab />);

    expect(await screen.findByRole("button", { name: "おふろそうじ を上へ" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "しょっきあらい を下へ" })).toBeDisabled();
    // 端でなければ押せる
    expect(screen.getByRole("button", { name: "いぬのさんぽ を上へ" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "いぬのさんぽ を下へ" })).toBeEnabled();
  });

  it("並びが古いと言われたら、読み込み直して知らせる", async () => {
    // 親が並べ替えている間に、子が「そのほか」で1件足した、という場面
    vi.mocked(api.reorderChores).mockRejectedValueOnce(
      new ApiError(409, "conflict", "お手伝いメニューが変わっています。読み込み直してください"),
    );
    renderScreen(<SettingsTab />);
    await screen.findByRole("button", { name: "おふろそうじ を下へ" });
    const loadsBefore = vi.mocked(api.bootstrap).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "おふろそうじ を下へ" }));

    expect(await screen.findByText(/読み込み直しました/)).toBeInTheDocument();
    expect(vi.mocked(api.bootstrap).mock.calls.length).toBeGreaterThan(loadsBefore);
  });
});

describe("追加", () => {
  it("名前を入れて追加すると、そのお手伝いが足される", async () => {
    vi.mocked(api.addChore).mockImplementation(async (name: string, emoji?: string) => {
      const created: Chore = {
        id: "cho_new",
        name,
        emoji: emoji ?? null,
        defaultCount: 1,
        useCount: 0,
        lastUsedAt: null,
        sortOrder: -1,
      };
      state = { ...state, chores: [created, ...state.chores] };
      return created;
    });
    renderScreen(<SettingsTab />);

    await userEvent.type(await screen.findByLabelText("あたらしいお手伝いの名前"), "まどふき");
    await userEvent.clear(screen.getByLabelText("絵文字"));
    await userEvent.type(screen.getByLabelText("絵文字"), "🪟");
    await userEvent.click(screen.getByRole("button", { name: "お手伝いを追加" }));

    await waitFor(() => expect(api.addChore).toHaveBeenCalledWith("まどふき", "🪟"));
    // 足したものは一番上に出る
    expect(await screen.findByRole("button", { name: "まどふき を上へ" })).toBeDisabled();
    // 入力欄は空に戻る
    expect(screen.getByLabelText("あたらしいお手伝いの名前")).toHaveValue("");
  });

  it("名前が空のときは追加できない", async () => {
    renderScreen(<SettingsTab />);

    expect(await screen.findByRole("button", { name: "お手伝いを追加" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("あたらしいお手伝いの名前"), "   ");
    expect(screen.getByRole("button", { name: "お手伝いを追加" })).toBeDisabled();
  });
});

it("説明文が、並べた順に子どもの台帳にも出ることを伝えている", async () => {
  renderScreen(<SettingsTab />);

  await screen.findByRole("button", { name: "おふろそうじ を下へ" });
  // 以前の「よく使う順にならびます」は、もう正しくない
  expect(screen.queryByText(/よく使う順/)).toBeNull();
  expect(screen.getByText(/ならべた順/)).toBeInTheDocument();
});
