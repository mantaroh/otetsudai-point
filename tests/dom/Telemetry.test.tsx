import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UiEventBatch } from "../../src/shared/types";
import {
  flush,
  screenTaps,
  startTelemetry,
  track,
  trackError,
  useScreen,
  visibleSince,
} from "../../src/client/lib/telemetry";

/**
 * 操作記録そのもののふるまい。
 *
 * ここで押さえたいのは3つ。
 *   1. 画面に入った・出たが、滞在時間つきで残ること
 *   2. つまずき(空振りタップ・連打)を拾えること
 *   3. **自由入力が絶対に混ざらないこと**。サーバも弾くが、送る側でも確かめる
 */

let sent: UiEventBatch[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  sent = [];
  stop = startTelemetry({ send: (batch) => sent.push(batch) });
});

afterEach(() => {
  stop();
});

/** 送信されたぶんも、まだ溜まっているぶんもまとめて見る */
function events() {
  flush();
  return sent.flatMap((batch) => batch.events);
}

function Screen({ name, children }: { name: string; children?: React.ReactNode }) {
  useScreen(name, "mem_hana");
  return <div>{children}</div>;
}

describe("画面の出入り", () => {
  it("入ったら view、出たら滞在時間つきの leave が残る", () => {
    const view = render(<Screen name="ledger" />);
    view.unmount();

    const [enter, exit] = events();
    expect(enter).toMatchObject({ type: "view", name: "enter", screen: "ledger" });
    expect(exit).toMatchObject({ type: "leave", name: "exit", screen: "ledger" });
    expect(exit?.value).toBeGreaterThanOrEqual(0);
    // 対象の子が分かる。子ごとに詰まる所が違うので、ここは持っておきたい
    expect(enter?.memberId).toBe("mem_hana");
  });

  it("連番は送信をまたいで続く(再送しても二重に数えられない)", () => {
    track("action", "stick");
    flush();
    track("action", "undo");
    flush();

    expect(events().map((event) => event.seq)).toEqual([0, 1]);
    expect(sent).toHaveLength(2);
    // 同じセッションとして送られる
    expect(sent[0]?.sessionId).toBe(sent[1]?.sessionId);
  });

  it("出てすぐ戻ってくると「引き返した」として残る", () => {
    render(<Screen name="shelf" />).unmount();
    render(<Screen name="shelf" />).unmount();

    expect(events().filter((event) => event.name === "revisit")).toHaveLength(1);
  });
});

describe("つまずきの検出", () => {
  it("反応しない場所へのタップを、場所の名前つきで拾う", async () => {
    const view = render(
      <Screen name="ledger">
        <div data-zone="sheet-grid">
          <span>マス</span>
        </div>
      </Screen>,
    );

    await userEvent.click(view.getByText("マス"));

    const dead = events().find((event) => event.name === "dead-tap");
    expect(dead).toMatchObject({ type: "friction", screen: "ledger", detail: "sheet-grid" });
  });

  it("ボタンを押したぶんは空振りにしない", async () => {
    const view = render(
      <Screen name="ledger">
        <button type="button">はる</button>
      </Screen>,
    );

    await userEvent.click(view.getByRole("button"));

    expect(events().some((event) => event.name === "dead-tap")).toBe(false);
  });

  it("同じボタンの連打は3回目で拾う", async () => {
    const view = render(
      <Screen name="ledger">
        <div data-zone="chore-picker">
          <button type="button">えらぶ</button>
        </div>
      </Screen>,
    );

    const button = view.getByRole("button");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(events().some((event) => event.name === "rage-tap")).toBe(false);

    await userEvent.click(button);
    expect(events().filter((event) => event.name === "rage-tap")).toHaveLength(1);
  });

  /**
   * シールボタンは「押した回数だけ貼る」のが仕様なので、連打は設計どおりの使われ方。
   * ここをつまずきとして数えると、いちばん健全な操作が最大の問題として並んでしまう。
   */
  it("連打してよい印が付いたボタンは数えない", async () => {
    const view = render(
      <Screen name="ledger">
        <button type="button" data-rage-ok>
          シールをはる
        </button>
      </Screen>,
    );

    const button = view.getByRole("button");
    for (let i = 0; i < 5; i++) await userEvent.click(button);

    expect(events().some((event) => event.name === "rage-tap")).toBe(false);
  });

  it("画面に入ってからのタップ数を数える", async () => {
    const view = render(
      <Screen name="ledger">
        <button type="button">はる</button>
      </Screen>,
    );

    await userEvent.click(view.getByRole("button"));
    await userEvent.click(view.getByRole("button"));

    expect(screenTaps()).toBe(2);
  });
});

describe("送る中身", () => {
  it("名前も金額も入力の中身も、記録には現れない", () => {
    trackError("bad_request", "stick");
    track("action", "redeem-submit", { detail: "roblox" });

    const serialized = JSON.stringify(events());
    expect(serialized).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });

  it("想定外の文字が来ても、送れる形に落とす", () => {
    trackError("えらー", "貼る");

    const [event] = events();
    expect(event?.name).toBe("unknown");
    expect(event?.detail).toBe("unknown");
  });

  it("止めたあとは何も記録しない", () => {
    stop();
    track("action", "stick");
    expect(sent).toEqual([]);
  });
});

describe("送信のタイミング", () => {
  it("溜まりきる前でも、画面が隠れたら送る", () => {
    track("action", "stick");
    expect(sent).toHaveLength(0);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(1);
  });

  /**
   * タブを閉じられると React の後始末が走らない。
   * 何もしないと「最後に見ていた画面」の滞在時間だけが常に欠ける。
   */
  it("タブを閉じられても、いまの画面の滞在時間は残る", () => {
    render(<Screen name="ledger" />);
    window.dispatchEvent(new Event("pagehide"));

    const exit = events().find((event) => event.type === "leave");
    expect(exit).toMatchObject({ screen: "ledger", name: "hide" });
    expect(exit?.value).toBeGreaterThanOrEqual(0);
  });

  /**
   * 画面を移ったのか、その画面でタブごと離れたのかを分けておかないと、
   * 「最後に見ていた画面 = そこで止まった画面」が読めない。
   */
  it("タブを離れたぶんと、画面を移ったぶんを分けて残す", () => {
    const view = render(<Screen name="ledger" />);
    window.dispatchEvent(new Event("pagehide"));
    view.unmount();

    const leaves = events().filter((event) => event.type === "leave");
    expect(leaves.map((event) => event.name)).toEqual(["hide", "exit"]);
  });

  it("どのビルドから来た記録かを送る", () => {
    track("action", "stick");
    flush();

    // ビルド時に埋まる。テストでは定義されないので dev になる
    expect(sent[0]?.appVersion).toBe("dev");
  });

  it("20件たまったら、待たずに送る", () => {
    for (let i = 0; i < 20; i++) track("action", "stick");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(20);
  });
});

/**
 * ホーム画面から開いた端末は、何日もタブが開いたままになる。
 * 時間の数え方をここで間違えると、標本が十数件しかない中央値がまるごと壊れる。
 */
describe("時間の数え方", () => {
  let now = 0;

  function setHidden(hidden: boolean) {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(hidden ? "hidden" : "visible");
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // 外側で始まっているぶんは、時計を差し替える前に作られている
    stop();
    sent = [];
    stop = startTelemetry({ send: (batch) => sent.push(batch) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("背面に回っている間は、滞在時間に積まれない", () => {
    const view = render(<Screen name="ledger" />);
    now += 5_000;
    setHidden(true);
    now += 60 * 60_000; // 1時間ぶん放置される
    setHidden(false);
    now += 3_000;
    view.unmount();

    const exit = events().find((event) => event.type === "leave" && event.name === "exit");
    expect(exit?.value).toBe(8_000);
  });

  it("開いたまま日をまたいでも、1枚目までの時間は見えていたぶんだけ", () => {
    render(<Screen name="ledger" />);
    now += 4_000;
    setHidden(true);
    now += 29 * 60 * 60_000; // 29時間。実際にこの値が記録に入っていた
    setHidden(false);
    now += 2_000;
    track("flow", "first-sticker", { value: visibleSince(1_700_000_000_000, 0) });

    const first = events().find((event) => event.name === "first-sticker");
    expect(first?.value).toBe(6_000);
  });

  it("間があくと、そこから別のセッションとして数える", () => {
    track("action", "stick");
    now += 31 * 60_000;
    track("action", "undo");
    flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.sessionId).not.toBe(sent[1]?.sessionId);
    // 新しいセッションの連番は先頭から
    expect(sent[1]?.events[0]).toMatchObject({ seq: 0, name: "undo" });
  });

  it("続けて使っている間は、同じセッションのまま", () => {
    track("action", "stick");
    now += 29 * 60_000;
    track("action", "undo");
    flush();

    expect(sent).toHaveLength(1);
    expect(events().map((event) => event.seq)).toEqual([0, 1]);
  });
});
