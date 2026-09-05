import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootstrapResponse } from "../../src/shared/types";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      updateSettings: vi.fn(),
      changePin: vi.fn(),
      devices: vi.fn(),
      createInvite: vi.fn(),
      revokeDevice: vi.fn(),
      updateChore: vi.fn(),
      updateMember: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      restoreMember: vi.fn(),
      archivedMembers: vi.fn(),
      updateDevice: vi.fn(),
      exportData: vi.fn(),
      verifyPin: vi.fn(),
      signOut: vi.fn(),
    },
  };
});

import { api, PinRequiredError } from "../../src/client/api";
import { SettingsTab } from "../../src/client/screens/ParentSettings";
import { CHORE_BATH, HANA, makeBootstrap, renderScreen } from "./helpers";

/**
 * せってい。
 *
 * 「設定は存在するのに画面から変えられない」を作らないための押さえ。
 * API があるのに UI から呼ばれていない、という状態をここで検出する。
 */

let state: BootstrapResponse;

beforeEach(() => {
  state = makeBootstrap();
  vi.mocked(api.bootstrap).mockImplementation(async () => state);
  vi.mocked(api.devices).mockResolvedValue([]);
  vi.mocked(api.archivedMembers).mockResolvedValue([]);
});

async function openSettings() {
  const user = userEvent.setup();
  renderScreen(<SettingsTab />);
  await screen.findByText("この家庭のルール");
  return user;
}

describe("家族", () => {
  // 「はな」は端末の招待ボタンにも出てくるので、家族の欄に絞って探す
  const family = () => within(screen.getByRole("heading", { name: "家族" }).closest("section")!);
  const openEditor = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
    await user.click(family().getByRole("button", { name }));
  };

  it("メンバーが並ぶ", async () => {
    await openSettings();
    expect(family().getByRole("button", { name: /はな/ })).toBeInTheDocument();
    expect(family().getByRole("button", { name: /たろう/ })).toBeInTheDocument();
    expect(family().getByRole("button", { name: /おとうさん/ })).toBeInTheDocument();
  });

  it("こどもか、おうちの人かが分かる", async () => {
    await openSettings();
    expect(family().getByRole("button", { name: /はな.*こども/ })).toBeInTheDocument();
    expect(family().getByRole("button", { name: /おとうさん.*おうちの人/ })).toBeInTheDocument();
  });

  it("押すと名前を編集できる", async () => {
    const user = await openSettings();
    expect(screen.queryByLabelText("名前")).not.toBeInTheDocument();

    await openEditor(user, /はな/);
    expect(screen.getByLabelText("名前")).toHaveValue(HANA.name);
  });

  it("名前を変えて保存できる", async () => {
    vi.mocked(api.updateMember).mockResolvedValue({ ...HANA, name: "はなこ" });
    const user = await openSettings();

    await openEditor(user, /はな/);
    const input = screen.getByLabelText("名前");
    await user.clear(input);
    await user.type(input, "はなこ");
    await user.click(screen.getByRole("button", { name: "ほぞん" }));

    await waitFor(() =>
      expect(api.updateMember).toHaveBeenCalledWith(
        HANA.id,
        { name: "はなこ", avatar: HANA.avatar, color: HANA.color },
        undefined,
      ),
    );
  });

  it("アイコンと色も変えられる", async () => {
    vi.mocked(api.updateMember).mockResolvedValue(HANA);
    const user = await openSettings();

    await openEditor(user, /はな/);
    await user.click(screen.getByRole("button", { name: "アイコン 🐼" }));
    await user.click(screen.getByRole("button", { name: "いろ #9bc53d" }));
    await user.click(screen.getByRole("button", { name: "ほぞん" }));

    await waitFor(() =>
      expect(api.updateMember).toHaveBeenCalledWith(
        HANA.id,
        expect.objectContaining({ avatar: "🐼", color: "#9bc53d" }),
        undefined,
      ),
    );
  });

  it("名前を空にしては保存できない", async () => {
    const user = await openSettings();
    await openEditor(user, /はな/);
    await user.clear(screen.getByLabelText("名前"));
    expect(screen.getByRole("button", { name: "ほぞん" })).toBeDisabled();
  });

  it("やめると、変更は送られない", async () => {
    const user = await openSettings();
    await openEditor(user, /はな/);
    await user.type(screen.getByLabelText("名前"), "こ");
    await user.click(screen.getByRole("button", { name: "やめる" }));

    expect(api.updateMember).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("名前")).not.toBeInTheDocument();
  });

  it("履歴の表示も変わることを伝える", async () => {
    const user = await openSettings();
    await openEditor(user, /はな/);
    expect(screen.getByText(/これまでの記録の表示も新しい名前になります/)).toBeInTheDocument();
  });

  describe("ふやす", () => {
    it("こどもを追加すると、台帳が始まることを伝える", async () => {
      const user = await openSettings();
      await user.click(screen.getByRole("button", { name: /家族をふやす/ }));

      expect(screen.getByLabelText("あたらしい家族の名前")).toBeInTheDocument();
      expect(screen.getByText(/1さつめの台帳がはじまります/)).toBeInTheDocument();
    });

    it("こどもとして追加できる", async () => {
      vi.mocked(api.addMember).mockResolvedValue({ ...HANA, id: "mem_new", name: "みなみ" });
      const user = await openSettings();

      await user.click(screen.getByRole("button", { name: /家族をふやす/ }));
      await user.type(screen.getByLabelText("あたらしい家族の名前"), "みなみ");
      await user.click(screen.getByRole("button", { name: "ふやす" }));

      await waitFor(() =>
        expect(api.addMember).toHaveBeenCalledWith(
          expect.objectContaining({ name: "みなみ", role: "child" }),
          undefined,
        ),
      );
    });

    it("おうちの人としても追加できる", async () => {
      vi.mocked(api.addMember).mockResolvedValue(HANA);
      const user = await openSettings();

      await user.click(screen.getByRole("button", { name: /家族をふやす/ }));
      await user.click(screen.getByRole("button", { name: "おうちの人" }));
      await user.type(screen.getByLabelText("あたらしい家族の名前"), "おかあさん");
      await user.click(screen.getByRole("button", { name: "ふやす" }));

      await waitFor(() =>
        expect(api.addMember).toHaveBeenCalledWith(
          expect.objectContaining({ name: "おかあさん", role: "parent" }),
          undefined,
        ),
      );
      // おうちの人には台帳が要らないので、その案内は出さない
      expect(screen.queryByText(/1さつめの台帳がはじまります/)).not.toBeInTheDocument();
    });

    it("名前が空のままでは追加できない", async () => {
      const user = await openSettings();
      await user.click(screen.getByRole("button", { name: /家族をふやす/ }));
      expect(screen.getByRole("button", { name: "ふやす" })).toBeDisabled();
    });
  });

  describe("はずす", () => {
    it("記録が残ることを伝えたうえで、しまう", async () => {
      vi.mocked(api.removeMember).mockResolvedValue({ ok: true, purged: false });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const user = await openSettings();

      await openEditor(user, /はな/);
      await user.click(screen.getByRole("button", { name: /この人を家族からはずす/ }));

      expect(confirmSpy.mock.calls[0]![0]).toContain("記録は残ります");
      await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith(HANA.id, {}, undefined));
    });

    it("確認を取り消したら、はずさない", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const user = await openSettings();

      await openEditor(user, /はな/);
      await user.click(screen.getByRole("button", { name: /この人を家族からはずす/ }));
      expect(api.removeMember).not.toHaveBeenCalled();
    });
  });

  describe("しまってある人", () => {
    it("いなければ、欄ごと出さない", async () => {
      await openSettings();
      expect(screen.queryByText("しまってある人")).not.toBeInTheDocument();
    });

    it("もどせる", async () => {
      vi.mocked(api.archivedMembers).mockResolvedValue([{ ...HANA, id: "mem_old", name: "むかしの子" }]);
      vi.mocked(api.restoreMember).mockResolvedValue(HANA);
      const user = await openSettings();

      expect(await screen.findByText("しまってある人")).toBeInTheDocument();
      expect(screen.getByText(/そのときの台帳から続けられます/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "もどす" }));
      await waitFor(() => expect(api.restoreMember).toHaveBeenCalledWith("mem_old", undefined));
    });

    it("完全に削除もできる", async () => {
      vi.mocked(api.archivedMembers).mockResolvedValue([{ ...HANA, id: "mem_old", name: "むかしの子" }]);
      vi.mocked(api.removeMember).mockResolvedValue({ ok: true, purged: true });
      const user = await openSettings();

      await user.click(await screen.findByRole("button", { name: "完全に削除" }));
      await waitFor(() =>
        expect(api.removeMember).toHaveBeenCalledWith("mem_old", { purge: true }, undefined),
      );
    });

    it("記録があって消せないときは、理由が出る", async () => {
      vi.mocked(api.archivedMembers).mockResolvedValue([{ ...HANA, id: "mem_old", name: "むかしの子" }]);
      vi.mocked(api.removeMember).mockRejectedValue(
        new Error("記録が残っているので完全には削除できません。「しまう」を使ってください"),
      );
      const user = await openSettings();

      await user.click(await screen.findByRole("button", { name: "完全に削除" }));
      expect(await screen.findByText(/記録が残っているので完全には削除できません/)).toBeInTheDocument();
    });
  });
});

describe("ルール", () => {
  it("トグルで切り替えられる", async () => {
    vi.mocked(api.updateSettings).mockResolvedValue(state.settings);
    const user = await openSettings();

    await user.click(screen.getByRole("switch", { name: "シールに親の承認をもとめる" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ requireApproval: true }, undefined),
    );

    await user.click(screen.getByRole("switch", { name: "子どもが自分で貼れる" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenLastCalledWith({ allowSelfGrant: false }, undefined),
    );
  });

  it("いまの状態がトグルに反映される", async () => {
    await openSettings();
    expect(screen.getByRole("switch", { name: "子どもが自分で貼れる" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "シールに親の承認をもとめる" })).not.toBeChecked();
  });

  it("マス数を選べる", async () => {
    vi.mocked(api.updateSettings).mockResolvedValue(state.settings);
    const user = await openSettings();

    const group = screen.getByRole("group", { name: "台帳1さつのマス数" });
    await user.click(within(group).getByRole("button", { name: "30" }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ capacity: 30 }, undefined));
  });

  it("選択肢に無い数も入れられる", async () => {
    vi.mocked(api.updateSettings).mockResolvedValue(state.settings);
    const user = await openSettings();

    await user.type(screen.getByLabelText("そのほかのマス数"), "12");
    await user.click(screen.getByRole("button", { name: "決定" }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ capacity: 12 }, undefined));
  });

  it("使いかけの台帳が変わらないことを伝える", async () => {
    await openSettings();
    expect(screen.getByText(/使いかけの台帳はそのまま/)).toBeInTheDocument();
    expect(screen.getByText(/いまは 5 マス/)).toBeInTheDocument();
  });
});

describe("PIN の変更", () => {
  it("2つの入力が一致しないと変えられない", async () => {
    const user = await openSettings();
    const change = screen.getByRole("button", { name: "PIN を変える" });

    expect(change).toBeDisabled();
    await user.type(screen.getByLabelText("あたらしい PIN"), "4821");
    expect(change).toBeDisabled();

    await user.type(screen.getByLabelText("あたらしい PIN(確認)"), "4822");
    expect(screen.getByText("2つの PIN が一致しません")).toBeInTheDocument();
    expect(change).toBeDisabled();
  });

  it("4桁未満は受け付けない", async () => {
    const user = await openSettings();
    await user.type(screen.getByLabelText("あたらしい PIN"), "123");
    await user.type(screen.getByLabelText("あたらしい PIN(確認)"), "123");
    expect(screen.getByRole("button", { name: "PIN を変える" })).toBeDisabled();
  });

  it("一致すれば変えられる", async () => {
    vi.mocked(api.changePin).mockResolvedValue({ ok: true });
    const user = await openSettings();

    await user.type(screen.getByLabelText("あたらしい PIN"), "4821");
    await user.type(screen.getByLabelText("あたらしい PIN(確認)"), "4821");
    await user.click(screen.getByRole("button", { name: "PIN を変える" }));

    await waitFor(() => expect(api.changePin).toHaveBeenCalledWith("4821", undefined));
    expect(await screen.findByText("PIN を変えました")).toBeInTheDocument();
  });

  it("いまの PIN を求められたら、テンキーを通してから変える", async () => {
    vi.mocked(api.changePin).mockImplementation(async (_next, pin) => {
      if (!pin) throw new PinRequiredError(401, "pin_required", "親の PIN が必要です");
      return { ok: true };
    });
    vi.mocked(api.verifyPin).mockResolvedValue({ ok: true });
    const user = await openSettings();

    await user.type(screen.getByLabelText("あたらしい PIN"), "4821");
    await user.type(screen.getByLabelText("あたらしい PIN(確認)"), "4821");
    await user.click(screen.getByRole("button", { name: "PIN を変える" }));

    expect(await screen.findByText("おうちの人のPIN")).toBeInTheDocument();
    for (const digit of "1234") await user.click(screen.getByRole("button", { name: digit }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.changePin).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.changePin).mock.calls[1]).toEqual(["4821", "1234"]);
  });
});

describe("端末", () => {
  const TABLET = {
    id: "dev_1",
    label: "リビングのiPad",
    kind: "shared",
    memberId: null,
    createdAt: 1,
    lastSeenAt: Date.UTC(2026, 7, 1),
  };

  it("登録ずみの端末が並ぶ", async () => {
    vi.mocked(api.devices).mockResolvedValue([
      TABLET,
      {
        id: "dev_2",
        label: "はなのスマホ",
        kind: "child",
        memberId: HANA.id,
        createdAt: 1,
        lastSeenAt: null,
      },
    ]);

    await openSettings();
    expect(await screen.findByText("リビングのiPad")).toBeInTheDocument();
    expect(screen.getByText(/みんなで使う/)).toBeInTheDocument();
    expect(screen.getByText(/子ども専用 ・ はな/)).toBeInTheDocument();
  });

  /** 名前を見なくても、何ができる端末なのかが分かるようにしておく */
  it("種類ごとに、できることが書いてある", async () => {
    vi.mocked(api.devices).mockResolvedValue([
      TABLET,
      { id: "dev_2", label: "はなのスマホ", kind: "child", memberId: HANA.id, createdAt: 1, lastSeenAt: null },
      { id: "dev_3", label: "親のスマホ", kind: "parent", memberId: null, createdAt: 1, lastSeenAt: null },
    ]);

    await openSettings();
    expect(await screen.findByText(/だれの台帳にも貼れる/)).toBeInTheDocument();
    expect(screen.getByText("その子の台帳しか開かない")).toBeInTheDocument();
    expect(screen.getByText("親の操作ができる")).toBeInTheDocument();
  });

  it("名前を変えられる", async () => {
    vi.mocked(api.devices).mockResolvedValue([TABLET]);
    vi.mocked(api.updateDevice).mockResolvedValue({
      id: "dev_1",
      label: "こどもべやのiPad",
      kind: "shared",
      memberId: null,
    });

    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: "名前を変える" }));

    const input = screen.getByLabelText("端末の名前");
    expect(input).toHaveValue("リビングのiPad");
    await user.clear(input);
    await user.type(input, "こどもべやのiPad");
    await user.click(screen.getByRole("button", { name: "ほぞん" }));

    await waitFor(() =>
      expect(api.updateDevice).toHaveBeenCalledWith(
        "dev_1",
        { label: "こどもべやのiPad" },
        undefined,
      ),
    );
  });

  it("名前を空にしては保存できない", async () => {
    vi.mocked(api.devices).mockResolvedValue([TABLET]);
    const user = await openSettings();

    await user.click(await screen.findByRole("button", { name: "名前を変える" }));
    await user.clear(screen.getByLabelText("端末の名前"));
    expect(screen.getByRole("button", { name: "ほぞん" })).toBeDisabled();
  });

  it("失効させられる", async () => {
    vi.mocked(api.devices).mockResolvedValue([
      { id: "dev_1", label: "なくしたiPad", kind: "shared", memberId: null, createdAt: 1, lastSeenAt: null },
    ]);
    vi.mocked(api.revokeDevice).mockResolvedValue({ ok: true });

    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: "失効" }));

    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith("dev_1", undefined));
  });

  it("確認を取り消したら失効しない", async () => {
    vi.mocked(api.devices).mockResolvedValue([
      { id: "dev_1", label: "iPad", kind: "shared", memberId: null, createdAt: 1, lastSeenAt: null },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: "失効" }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
  });

  /** せっていを開いた瞬間にテンキーが出るのは唐突なので、ボタンにしてある */
  it("一覧が見られないときは、PIN を入れるボタンが出る(いきなりテンキーは出さない)", async () => {
    vi.mocked(api.devices).mockRejectedValue(
      new PinRequiredError(401, "pin_required", "親の PIN が必要です"),
    );

    await openSettings();
    expect(await screen.findByRole("button", { name: /PIN を入れて/ })).toBeInTheDocument();
    expect(screen.queryByText("おうちの人のPIN")).not.toBeInTheDocument();
  });

  it("招待リンクを発行できる", async () => {
    vi.mocked(api.createInvite).mockResolvedValue({ url: "http://x/invite/abc", expiresAt: 1 });
    const user = await openSettings();

    await user.click(screen.getByRole("button", { name: /共有タブレット用/ }));
    await waitFor(() =>
      expect(api.createInvite).toHaveBeenCalledWith(
        { kind: "shared", label: "リビングのタブレット", memberId: undefined },
        undefined,
      ),
    );
    expect(await screen.findByText(/http:\/\/x\/invite\/abc/)).toBeInTheDocument();
  });
});

describe("発行した招待リンクの渡し方", () => {
  const INVITE_URL = "https://otetsudai.example.com/invite/abc123";

  async function issueInvite() {
    vi.mocked(api.createInvite).mockResolvedValue({
      url: INVITE_URL,
      expiresAt: Date.UTC(2026, 7, 6, 12, 0),
    });
    const user = await openSettings();
    await user.click(screen.getByRole("button", { name: /共有タブレット用/ }));
    await screen.findByRole("button", { name: "コピー" });
    return user;
  }

  it("QR コードが出る", async () => {
    await issueInvite();
    expect(await screen.findByRole("img", { name: "招待リンクの QR コード" })).toBeInTheDocument();
    expect(screen.getByText(/カメラで読み取って/)).toBeInTheDocument();
  });

  it("QR は隠せる", async () => {
    const user = await issueInvite();
    await screen.findByRole("img", { name: "招待リンクの QR コード" });

    await user.click(screen.getByRole("button", { name: "QR をかくす" }));
    expect(screen.queryByRole("img", { name: "招待リンクの QR コード" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "QR を出す" }));
    expect(await screen.findByRole("img", { name: "招待リンクの QR コード" })).toBeInTheDocument();
  });

  /**
   * 既定で付けている。付いていて困る場面が無く、
   * 付け忘れると LINE 経由の登録が丸ごと無駄になるため。
   */
  it("はじめから LINE 用の印が付いている", async () => {
    await issueInvite();
    expect(screen.getByRole("checkbox", { name: /LINE で送る用にする/ })).toBeChecked();
    expect(screen.getByText(`${INVITE_URL}?openExternalBrowser=1`)).toBeInTheDocument();
  });

  it("外すと、素の URL に戻る", async () => {
    const user = await issueInvite();
    await user.click(screen.getByRole("checkbox", { name: /LINE で送る用にする/ }));

    expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    expect(screen.queryByText(/openExternalBrowser/)).not.toBeInTheDocument();
  });

  it("コピーされるのは、いま表示されている URL", async () => {
    // userEvent.setup() が navigator.clipboard を差し替えるので、それをそのまま読む
    const user = await issueInvite();

    await user.click(screen.getByRole("button", { name: "コピー" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(`${INVITE_URL}?openExternalBrowser=1`),
    );

    await user.click(screen.getByRole("checkbox", { name: /LINE で送る用にする/ }));
    await user.click(screen.getByRole("button", { name: "コピー" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(INVITE_URL));
  });

  it("共有シートが使える端末では、送るボタンが出る", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });

    const user = await issueInvite();
    await user.click(screen.getByRole("button", { name: "LINE などで送る" }));

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ url: `${INVITE_URL}?openExternalBrowser=1` }),
      ),
    );

    Reflect.deleteProperty(navigator, "share");
  });

  it("有効期限と、1回だけ使えることが分かる", async () => {
    await issueInvite();
    expect(screen.getByText(/1回だけ使えます/)).toBeInTheDocument();
  });
});

describe("お手伝いメニュー", () => {
  it("押すと編集できる", async () => {
    const user = await openSettings();
    expect(screen.queryByLabelText("お手伝いの名前")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: new RegExp(CHORE_BATH.name) }));
    expect(screen.getByLabelText("お手伝いの名前")).toHaveValue(CHORE_BATH.name);
  });

  it("名前・絵文字・めやす枚数を変えられる", async () => {
    vi.mocked(api.updateChore).mockResolvedValue({ ...CHORE_BATH, name: "おふろあらい" });
    const user = await openSettings();

    await user.click(screen.getByRole("button", { name: new RegExp(CHORE_BATH.name) }));
    const nameInput = screen.getByLabelText("お手伝いの名前");
    await user.clear(nameInput);
    await user.type(nameInput, "おふろあらい");
    await user.click(screen.getByRole("button", { name: "絵文字 🧹" }));
    await user.click(screen.getByRole("button", { name: "めやす枚数をふやす" }));
    await user.click(screen.getByRole("button", { name: "めやす枚数をふやす" }));
    await user.click(screen.getByRole("button", { name: "ほぞん" }));

    await waitFor(() =>
      expect(api.updateChore).toHaveBeenCalledWith(
        CHORE_BATH.id,
        { name: "おふろあらい", emoji: "🧹", defaultCount: 3 },
        undefined,
      ),
    );
  });

  it("しまう(アーカイブ)ができ、記録は残ると伝える", async () => {
    vi.mocked(api.updateChore).mockResolvedValue(CHORE_BATH);
    const user = await openSettings();

    await user.click(screen.getByRole("button", { name: new RegExp(CHORE_BATH.name) }));
    expect(screen.getByText(/これまでの記録は残ります/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "しまう" }));
    await waitFor(() =>
      expect(api.updateChore).toHaveBeenCalledWith(CHORE_BATH.id, { archived: true }, undefined),
    );
  });

  it("名前を空にしては保存できない", async () => {
    const user = await openSettings();
    await user.click(screen.getByRole("button", { name: new RegExp(CHORE_BATH.name) }));
    await user.clear(screen.getByLabelText("お手伝いの名前"));
    expect(screen.getByRole("button", { name: "ほぞん" })).toBeDisabled();
  });
});

describe("データの持ち出し", () => {
  it("書き出せる", async () => {
    vi.mocked(api.exportData).mockResolvedValue({ exportedAt: 1, data: {} });
    // jsdom には URL.createObjectURL が無い
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });

    const user = await openSettings();
    await user.click(screen.getByRole("button", { name: "書き出す" }));

    await waitFor(() => expect(api.exportData).toHaveBeenCalled());
  });
});
