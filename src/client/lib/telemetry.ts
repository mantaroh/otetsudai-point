import { useEffect } from "react";
import type { UiEventBatch, UiEventInput, UiEventType } from "../../shared/types";

/**
 * 画面の操作記録。
 *
 * 目的は「UI のどこが使いにくいか」を、印象ではなく数で見ること。
 * 集計して意味のあるものだけを、こちらで名前を決めて記録する。
 *
 * 守っていること:
 *   - **画面を描き直さない。** すべて ref とイベントリスナだけで動く。
 *     記録のために再レンダリングが起きると、それ自体が体験を悪くする。
 *   - **自由入力を送らない。** 送るのは固定の識別子と数値だけ。
 *     お手伝いの名前も、交換したものも、入力途中の文字も入らない。
 *     サーバ側でも [A-Za-z0-9_:-] しか受け付けないので、うっかり混ぜたら落ちる。
 *   - **失敗しても黙る。** 記録が送れないことでアプリの操作が止まってはいけない。
 *   - **startTelemetry() を呼ぶまで完全に何もしない。** 画面テストは main.tsx を
 *     通らないので、テスト中に勝手な通信が発生しない。
 */

const ENDPOINT = "/api/ui-events";
/** 溜まったら送る枚数 */
const FLUSH_AT = 20;
/** 溜まりきらなくても、これだけ経ったら送る */
const FLUSH_AFTER_MS = 10_000;
/** 1セッションで記録する上限。連打だけで DB を埋めさせない */
const MAX_SESSION_EVENTS = 400;
/** 空振りタップは同じセッションで数えすぎない */
const MAX_DEAD_TAPS = 20;
/**
 * これだけ何も起きなかったら、次の記録から別のセッションとして数える。
 *
 * タブ1つを1セッションにしていたら、ホーム画面から開きっぱなしの端末で
 * 50時間ぶんが1セッションになっていた。こうなるとセッション数もファネルも実態を映さない。
 */
const SESSION_IDLE_MS = 30 * 60_000;

/** ビルド時に埋まる。開発サーバとテストでは定義されないので "dev" になる */
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const TAPPABLE = 'button,a,input,textarea,select,label,summary,[role="button"],[contenteditable]';

type Send = (batch: UiEventBatch) => void;

interface Recorder {
  sessionId: string;
  send: Send;
  queue: UiEventInput[];
  seq: number;
  recorded: number;
  deadTaps: number;
  timer: ReturnType<typeof setTimeout> | null;
  enabled: boolean;
  /** 直近に記録した時刻。ここから離れすぎていたらセッションを切り直す */
  lastEventAt: number;
  /** 画面が隠れた時刻。表に戻ったときに hiddenMs へ積む。見えている間は null */
  hiddenAt: number | null;
  /** 記録を始めてからの、画面が隠れていた時間の合計 */
  hiddenMs: number;
  screen: string;
  /** いまの画面に入った時刻。タブを閉じられたときの滞在時間もここから出す */
  screenEnteredAt: number;
  /** いまの画面に入った時点の hiddenMs。滞在時間から背面の時間を引くのに使う */
  screenEnteredHidden: number;
  memberId: string | undefined;
  /** 画面ごとの直近の離脱時刻。すぐ戻ってきたら「引き返した」とみなす */
  leftAt: Map<string, number>;
  /** いまの画面に入ってからのタップ数。「1枚貼るのに何回押したか」に使う */
  tapsOnScreen: number;
  taps: { target: EventTarget | null; x: number; y: number; at: number; count: number };
}

let recorder: Recorder | null = null;

/**
 * 記録を始める。main.tsx から1回だけ呼ぶ。
 * 戻り値を呼ぶと、リスナを外して完全に止まる(テスト用)。
 */
export function startTelemetry(options: { send?: Send } = {}): () => void {
  if (recorder) return () => undefined;

  recorder = {
    sessionId: newSessionId(),
    send: options.send ?? beaconSend,
    queue: [],
    seq: 0,
    recorded: 0,
    deadTaps: 0,
    timer: null,
    enabled: true,
    lastEventAt: 0,
    hiddenAt: null,
    hiddenMs: 0,
    screen: "boot",
    screenEnteredAt: Date.now(),
    screenEnteredHidden: 0,
    memberId: undefined,
    leftAt: new Map(),
    tapsOnScreen: 0,
    taps: { target: null, x: 0, y: 0, at: 0, count: 0 },
  };

  const onPointerDown = (event: PointerEvent) => handlePointerDown(event);
  /**
   * 表に出ていない間の時間を、滞在時間に混ぜない。
   *
   * ここを数えていたせいで、開いたまま放置されたタブの滞在時間に39時間が入り、
   * 標本が十数件しかない中央値が使い物にならなくなっていた。
   */
  const onVisibility = () => {
    const current = recorder;
    if (!current) return;
    if (document.visibilityState === "hidden") {
      current.hiddenAt = Date.now();
      flush();
    } else if (current.hiddenAt !== null) {
      current.hiddenMs += Date.now() - current.hiddenAt;
      current.hiddenAt = null;
    }
  };
  /**
   * タブを閉じられると React の後始末は走らないので、いまの画面の leave が
   * 記録されないまま終わる。それを放っておくと「最後に見ていた画面」の滞在時間だけが
   * 常に欠けることになり、どの画面で止まっているかが読めなくなる。
   *
   * 画面遷移の leave(exit)とは name を分ける。
   * hide が多い画面が「そこで離脱している画面」で、直す優先度がいちばん高い。
   */
  const onPageHide = () => {
    const current = recorder;
    if (current && current.screen !== "boot") {
      track("leave", "hide", {
        value: visibleSince(current.screenEnteredAt, current.screenEnteredHidden),
      });
      // 戻る操作で復帰したときに、同じ時間を二重に数えないよう起点を進める
      current.screenEnteredAt = Date.now();
      current.screenEnteredHidden = hiddenElapsed();
    }
    flush();
  };
  const onPopState = () => track("action", "back-gesture");

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("popstate", onPopState);

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("popstate", onPopState);
    if (recorder?.timer) clearTimeout(recorder.timer);
    recorder = null;
  };
}

/**
 * 家庭の設定で記録を止められるようにする。
 * サーバ側でも捨てているが、送らずに済むならそのほうがよい。
 */
export function setTelemetryEnabled(enabled: boolean): void {
  if (!recorder || recorder.enabled === enabled) return;
  recorder.enabled = enabled;
  if (!enabled) recorder.queue = [];
}

export interface TrackOptions {
  value?: number;
  detail?: string;
  /** 省略すると、いま開いている画面の対象の子になる */
  memberId?: string;
  screen?: string;
}

export function track(type: UiEventType, name: string, options: TrackOptions = {}): void {
  const current = recorder;
  if (!current || !current.enabled) return;

  const now = Date.now();
  // 間が空いたら、ここから先は別のセッションとして数える。
  // 開きっぱなしのタブを1セッションにしていると、日をまたいだぶんが全部同じ通しになる
  if (current.lastEventAt > 0 && now - current.lastEventAt >= SESSION_IDLE_MS) {
    rotateSession(current);
  }
  if (current.recorded >= MAX_SESSION_EVENTS) return;

  current.lastEventAt = now;
  current.recorded += 1;
  current.queue.push({
    seq: current.seq++,
    t: now,
    screen: options.screen ?? current.screen,
    type,
    name,
    ...(options.value === undefined ? {} : { value: Math.round(options.value) }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.memberId ?? current.memberId
      ? { memberId: options.memberId ?? current.memberId }
      : {}),
  });

  if (current.queue.length >= FLUSH_AT) flush();
  else scheduleFlush(current);
}

export function flush(): void {
  const current = recorder;
  if (!current) return;
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  if (current.queue.length === 0) return;

  const events = current.queue;
  current.queue = [];
  // 送れなかったぶんは諦める。UI 改善の指標なので、取りこぼしより
  // 「送信の再試行がアプリの邪魔をしないこと」を優先する
  current.send({
    sessionId: current.sessionId,
    now: Date.now(),
    appVersion: APP_VERSION,
    events,
  });
}

function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * セッションを切り直す。
 *
 * 溜まっているぶんは、切り替える前に古いセッションのまま送り切る。
 * ここで送らずに ID だけ差し替えると、seq が 0 に戻って
 * 新しいセッションの先頭とぶつかり、(session_id, seq) の UNIQUE で捨てられてしまう。
 */
function rotateSession(current: Recorder): void {
  flush();
  current.sessionId = newSessionId();
  current.seq = 0;
  current.recorded = 0;
  current.deadTaps = 0;
}

function scheduleFlush(current: Recorder): void {
  if (current.timer) return;
  current.timer = setTimeout(() => {
    current.timer = null;
    flush();
  }, FLUSH_AFTER_MS);
}

function beaconSend(batch: UiEventBatch): void {
  const body = JSON.stringify(batch);
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {
    // sendBeacon が使えない環境では fetch に落とす
  }
  void fetch(ENDPOINT, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    // 画面を閉じる途中でも送り切る
    keepalive: true,
  }).catch(() => undefined);
}

// ── 見えていた時間 ────────────────────────────

/**
 * 記録を始めてからの「画面が隠れていた時間の合計」。
 *
 * 時間を測り始めるときに、開始時刻と一緒にこの値も控えておく。
 * そうしないと、タブを開いたまま放置された時間がまるごと滞在時間になる
 * (実際に39時間や29時間が記録されていた)。
 */
export function hiddenElapsed(): number {
  const current = recorder;
  if (!current) return 0;
  return current.hiddenMs + (current.hiddenAt === null ? 0 : Date.now() - current.hiddenAt);
}

/**
 * at から今までのうち、画面が見えていた時間だけを返す。
 * hiddenAt には、測り始めたときの hiddenElapsed() を渡す。
 */
export function visibleSince(at: number, hiddenAt: number): number {
  return Math.max(0, Date.now() - at - (hiddenElapsed() - hiddenAt));
}

// ── 画面 ──────────────────────────────────────

/**
 * 画面に入った・出たを記録する。
 *
 * leave の value が滞在ミリ秒になる。ここが「どの画面で止まっているか」の元になる。
 * 数えるのは表に出ていた時間だけで、背面に回っていた時間は引く。
 * state を持たないので、この hook が再レンダリングを起こすことはない。
 */
export function useScreen(screen: string, memberId?: string): void {
  useEffect(() => {
    const current = recorder;
    if (!current) return;

    const previous = { screen: current.screen, memberId: current.memberId };
    current.screen = screen;
    current.memberId = memberId;
    current.tapsOnScreen = 0;

    const enteredAt = Date.now();
    current.screenEnteredAt = enteredAt;
    current.screenEnteredHidden = hiddenElapsed();
    const left = current.leftAt.get(screen);
    track("view", "enter");
    // 出てすぐ戻ってきた = 目当てのものが無くて引き返した可能性が高い
    if (left !== undefined && enteredAt - left < 20_000) {
      track("friction", "revisit", { value: enteredAt - left });
    }

    return () => {
      const active = recorder;
      // pagehide でいちど leave を出していたら、その続きぶんだけを数える
      const startedAt = active?.screenEnteredAt ?? enteredAt;
      const startedHidden = active?.screenEnteredHidden ?? 0;
      track("leave", "exit", {
        value: visibleSince(startedAt, startedHidden),
        screen,
        memberId,
      });
      if (!active) return;
      active.leftAt.set(screen, Date.now());
      active.screen = previous.screen;
      active.memberId = previous.memberId;
    };
  }, [screen, memberId]);
}

// ── つまずきの検出 ────────────────────────────

/**
 * 反応しない場所へのタップと、連打を拾う。
 *
 * 「押せると思って押したのに何も起きない」は、画面を見ているだけでは気づけない。
 * どこを押しているかは data-zone で場所の名前だけ取る(座標は取らない)。
 */
function handlePointerDown(event: PointerEvent): void {
  const current = recorder;
  if (!current || !current.enabled) return;

  current.tapsOnScreen += 1;

  const target = event.target instanceof Element ? event.target : null;
  const zone = target?.closest<HTMLElement>("[data-zone]")?.dataset.zone ?? "none";
  const tappable = target?.closest(TAPPABLE) ?? null;

  if (!tappable) {
    if (current.deadTaps < MAX_DEAD_TAPS) {
      current.deadTaps += 1;
      track("friction", "dead-tap", { detail: zone });
    }
    return;
  }

  // 連打してよい所(シールボタン)は数えない。あそこは押した回数だけ貼る作りなので、
  // 連打はむしろ設計どおりの使われ方になる
  if (tappable.closest("[data-rage-ok]")) return;

  const taps = current.taps;
  const now = Date.now();
  const near =
    taps.target === tappable &&
    now - taps.at < 800 &&
    Math.abs(event.clientX - taps.x) < 32 &&
    Math.abs(event.clientY - taps.y) < 32;

  taps.count = near ? taps.count + 1 : 1;
  taps.target = tappable;
  taps.x = event.clientX;
  taps.y = event.clientY;
  taps.at = now;

  if (taps.count === 3) track("friction", "rage-tap", { detail: zone });
}

/** いまの画面に入ってから何回タップされたか */
export function screenTaps(): number {
  return recorder?.tapsOnScreen ?? 0;
}

// ── よく使う記録 ──────────────────────────────

/** API が失敗した。name はサーバのエラーコード(pin_required など) */
export function trackError(code: string, operation: string): void {
  track("error", sanitize(code), { detail: sanitize(operation) });
}

/** サーバのエラーコードは英数字だが、想定外の値が来ても記録側で落ちないようにする */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}
