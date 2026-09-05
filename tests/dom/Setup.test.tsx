import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return { ...actual, api: { createFamily: vi.fn() } };
});

import { api } from "../../src/client/api";
import { SetupScreen } from "../../src/client/screens/Setup";
import { renderScreen } from "./helpers";

/**
 * オンボーディング。他家庭に開くなら、ここでつまずくと二度と戻ってこない。
 */

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("やまだ家"), "  やまだ家  ");
  await user.type(screen.getByPlaceholderText("おかあさん"), "おとうさん");
  await user.type(screen.getByPlaceholderText("1234"), "4821");
  await user.type(screen.getByPlaceholderText("1人目の名前"), "はな");
  await user.type(screen.getByPlaceholderText("2人目の名前"), "たろう");
}

const submitButton = () => screen.getByRole("button", { name: "はじめる" });

describe("はじめの設定", () => {
  it("必要な項目が埋まるまで、はじめる を押せない", async () => {
    const user = userEvent.setup();
    renderScreen(<SetupScreen />);

    expect(submitButton()).toBeDisabled();
    await fillValidForm(user);
    expect(submitButton()).toBeEnabled();
  });

  it("PIN が4桁未満なら押せない", async () => {
    const user = userEvent.setup();
    renderScreen(<SetupScreen />);

    await user.type(screen.getByPlaceholderText("やまだ家"), "やまだ家");
    await user.type(screen.getByPlaceholderText("おかあさん"), "おとうさん");
    await user.type(screen.getByPlaceholderText("1人目の名前"), "はな");
    await user.type(screen.getByPlaceholderText("1234"), "123");
    expect(submitButton()).toBeDisabled();

    await user.type(screen.getByPlaceholderText("1234"), "4");
    expect(submitButton()).toBeEnabled();
  });

  it("PIN の欄に数字以外は入らない", async () => {
    const user = userEvent.setup();
    renderScreen(<SetupScreen />);

    const pin = screen.getByPlaceholderText("1234");
    await user.type(pin, "12ab34");
    expect(pin).toHaveValue("1234");
  });

  it("子どもが1人も居なければ押せない", async () => {
    const user = userEvent.setup();
    renderScreen(<SetupScreen />);

    await user.type(screen.getByPlaceholderText("やまだ家"), "やまだ家");
    await user.type(screen.getByPlaceholderText("おかあさん"), "おとうさん");
    await user.type(screen.getByPlaceholderText("1234"), "4821");
    expect(submitButton()).toBeDisabled();
  });

  it("前後の空白は落として送る。空欄の子は送らない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createFamily).mockResolvedValue({ familyId: "fam_1" });
    const onCreated = vi.fn();
    renderScreen(<SetupScreen onCreated={onCreated} />);

    await user.type(screen.getByPlaceholderText("やまだ家"), "  やまだ家  ");
    await user.type(screen.getByPlaceholderText("おかあさん"), "おとうさん");
    await user.type(screen.getByPlaceholderText("1234"), "4821");
    await user.type(screen.getByPlaceholderText("1人目の名前"), "はな");
    // 2人目は空のまま
    await user.click(submitButton());

    await waitFor(() => expect(api.createFamily).toHaveBeenCalled());
    const payload = vi.mocked(api.createFamily).mock.calls[0]![0];
    expect(payload.familyName).toBe("やまだ家");
    expect(payload.children).toEqual([
      expect.objectContaining({ name: "はな" }),
    ]);
    expect(onCreated).toHaveBeenCalled();
  });

  it("マス数の既定は30(うちの運用)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createFamily).mockResolvedValue({ familyId: "fam_1" });
    renderScreen(<SetupScreen onCreated={() => {}} />);

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(api.createFamily).toHaveBeenCalled());
    expect(vi.mocked(api.createFamily).mock.calls[0]![0].capacity).toBe(30);
  });

  it("マス数は他家庭向けに選べる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createFamily).mockResolvedValue({ familyId: "fam_1" });
    renderScreen(<SetupScreen onCreated={() => {}} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "50" }));
    await user.click(submitButton());

    await waitFor(() => expect(api.createFamily).toHaveBeenCalled());
    expect(vi.mocked(api.createFamily).mock.calls[0]![0].capacity).toBe(50);
  });

  it("送信中は二重に押せない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createFamily).mockReturnValue(new Promise(() => {}));
    renderScreen(<SetupScreen onCreated={() => {}} />);

    await fillValidForm(user);
    await user.click(submitButton());

    await waitFor(() => expect(submitButton()).toBeDisabled());
    await user.click(submitButton());
    expect(api.createFamily).toHaveBeenCalledTimes(1);
  });

  it("お子さんを増やせる", async () => {
    const user = userEvent.setup();
    renderScreen(<SetupScreen />);

    expect(screen.queryByPlaceholderText("3人目の名前")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /お子さんを追加/ }));
    expect(screen.getByPlaceholderText("3人目の名前")).toBeInTheDocument();
  });

  it("失敗したら理由が出て、画面は残る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createFamily).mockRejectedValue(new Error("PIN は 4〜8 桁の数字で指定してください"));
    const onCreated = vi.fn();
    renderScreen(<SetupScreen onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(submitButton());

    expect(await screen.findByText("PIN は 4〜8 桁の数字で指定してください")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(submitButton()).toBeEnabled();
  });
});
