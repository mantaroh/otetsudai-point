import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/api")>();
  return { ...actual, api: { verifyPin: vi.fn() } };
});

import { api, PinRequiredError } from "../../src/client/api";
import { usePin } from "../../src/client/pin";
import { renderScreen } from "./helpers";

/**
 * 親操作の PIN。
 * 呼び出し側は PIN を意識せずに書き、401 が返ったときだけテンキーが出て、
 * 通ったら同じ操作が透過的に再実行される、という約束を確かめる。
 */

/** 1回目は PIN 無しで呼ばれて弾かれ、2回目は PIN つきで成功する操作 */
function makeGuardedAction() {
  return vi.fn(async (pin?: string) => {
    if (!pin) throw new PinRequiredError(401, "pin_required", "親の PIN が必要です");
    return `ok:${pin}`;
  });
}

function Harness({ action }: { action: (pin?: string) => Promise<unknown> }) {
  const { withPin } = usePin();
  return (
    <button
      type="button"
      onClick={() => {
        void withPin(action).catch(() => {});
      }}
    >
      じっこう
    </button>
  );
}

async function press(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const digit of digits) {
    await user.click(screen.getByRole("button", { name: digit }));
  }
}

describe("PIN", () => {
  it("PIN が要らない操作では、テンキーは出ない", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => "ok");
    renderScreen(<Harness action={action} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("おうちの人のPIN")).not.toBeInTheDocument();
  });

  it("PIN を求められたらテンキーが出て、通ったら同じ操作が再実行される", async () => {
    const user = userEvent.setup();
    const action = makeGuardedAction();
    vi.mocked(api.verifyPin).mockResolvedValue({ ok: true });
    renderScreen(<Harness action={action} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    expect(await screen.findByText("おうちの人のPIN")).toBeInTheDocument();

    await press(user, "1234");
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenLastCalledWith("1234");
    await waitFor(() => expect(screen.queryByText("おうちの人のPIN")).not.toBeInTheDocument());
  });

  it("4桁に満たないうちは OK が押せない", async () => {
    const user = userEvent.setup();
    renderScreen(<Harness action={makeGuardedAction()} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    await screen.findByText("おうちの人のPIN");

    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    await press(user, "123");
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    await press(user, "4");
    expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();
  });

  it("まちがった PIN では、操作は再実行されない", async () => {
    const user = userEvent.setup();
    const action = makeGuardedAction();
    vi.mocked(api.verifyPin).mockRejectedValue(new Error("PIN が違います"));
    renderScreen(<Harness action={action} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    await screen.findByText("おうちの人のPIN");
    await press(user, "9999");
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("PIN がちがいます")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    // 入力はクリアされ、続けて打ち直せる
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });

  it("やめる を押したら、操作は実行されない", async () => {
    const user = userEvent.setup();
    const action = makeGuardedAction();
    renderScreen(<Harness action={action} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    await screen.findByText("おうちの人のPIN");
    await user.click(screen.getByRole("button", { name: "やめる" }));

    await waitFor(() => expect(screen.queryByText("おうちの人のPIN")).not.toBeInTheDocument());
    expect(action).toHaveBeenCalledTimes(1);
    expect(api.verifyPin).not.toHaveBeenCalled();
  });

  it("← で1桁ずつ消せる", async () => {
    const user = userEvent.setup();
    renderScreen(<Harness action={makeGuardedAction()} />);

    await user.click(screen.getByRole("button", { name: "じっこう" }));
    await screen.findByText("おうちの人のPIN");
    await press(user, "1234");
    expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "←" }));
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });
});
