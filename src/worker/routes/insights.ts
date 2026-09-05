import { Hono } from "hono";
import type { UiEventBatch, UiEventInput } from "../../shared/types";
import { badRequest, notFound } from "../lib/errors";
import { asInt, asString, readJson } from "../lib/validate";
import { getSettings, getTimeZone } from "../db/family";
import { clearEvents, getInsights, listMemberIds, recordEvents, type StoredEvent } from "../db/uiEvents";
import { getAuth, requireParent } from "../auth/middleware";
import type { AppBindings } from "../types";

/**
 * 画面の操作記録と、その集計。
 *
 * 記録は誰でも書ける(子の端末が主な送り手)。
 * 読むのは親だけ。集計は「どこで詰まったか」を見るためのものなので、
 * 生のイベントは外に出さず、丸めたものだけを返す。
 */
export const insightsRoutes = new Hono<AppBindings>();

/** 1回の送信で受け取る上限。取りこぼすぶんは次の送信に回る */
const MAX_EVENTS = 40;

/**
 * screen / name / detail に許す文字。
 *
 * 意図的に日本語を通さない。ここを緩めた瞬間に、お手伝いの名前や交換したものといった
 * 自由入力が「detail」に紛れ込む余地ができる。集計に要らないものは、
 * 運用の約束ではなく、書き込み経路の制約として入れられないようにしておく。
 */
const LABEL = /^[A-Za-z0-9_:-]+$/;

const TYPES = new Set(["view", "leave", "step", "action", "flow", "friction", "error"]);

/**
 * 値の上限。用途によって「ありえない大きさ」が違う。
 *
 * 滞在時間と「1枚目まで」は、端末側で背面に回っていた時間を引いた可視時間なので、
 * 30分を超えていたら測り損ねている。上限は保険で、本命の対策は端末側にある。
 */
const MAX_VALUE = 2_592_000_000;
const MAX_DURATION = 1_800_000;

/** 捨てた行を数えるときに使う画面名。どの画面のものだったかは分からない */
const UNKNOWN_SCREEN = "unknown";

/**
 * 操作記録の受け取り。
 *
 * 端末は貯めてからまとめて送る(画面を離れるときは sendBeacon)。
 * 送信が再試行されても (session_id, seq) の UNIQUE で二重に数えない。
 */
insightsRoutes.post("/ui-events", async (c) => {
  const auth = getAuth(c);

  const settings = await getSettings(c.env.DB, auth.familyId);
  // 記録しない設定なら、受け取っても捨てる。
  // 端末側の判断に任せず、サーバでも止める
  if (!settings || settings.uiLogDays <= 0) return c.body(null, 204);

  const body = await readJson<UiEventBatch>(c.req.raw);
  const sessionId = asString(body.sessionId, "sessionId", { max: 64 });
  if (!LABEL.test(sessionId)) throw badRequest("sessionId の形式が不正です");

  const input = Array.isArray(body.events) ? body.events : [];
  if (input.length === 0) return c.body(null, 204);
  if (input.length > MAX_EVENTS) throw badRequest("1回に送れるイベント数を超えています");

  const receivedAt = Date.now();
  // 端末の時計は当てにならない(タブレットの時刻が年単位でずれていることがある)。
  // 「送信時点の端末時刻」との差を取って、サーバの時計に寄せてから記録する
  const skew = receivedAt - asInt(body.now, "now", { min: 0 });
  const oldest = receivedAt - 86_400_000;

  const knownMembers = await listMemberIds(c.env.DB, auth.familyId);

  /*
   * 通らなかった行だけを捨てる。
   *
   * 以前はここで 400 を返していたが、端末は送りっぱなしで再送しないので、
   * 1件が不正なだけで同じ送信の最大40件が消えていた。しかも消えたことが
   * どこにも残らないので、集計を見ても欠けに気づけない。
   *
   * 「うっかり自由入力を混ぜたら気づける」という性質は捨てない。
   * 捨てた件数を dropped として残すので、集計に出てくる。
   */
  const events: StoredEvent[] = [];
  const droppedSeqs: number[] = [];
  for (const event of input) {
    const stored = toStored(event, skew, oldest, receivedAt, knownMembers);
    if (stored) events.push(stored);
    else droppedSeqs.push(typeof event?.seq === "number" ? event.seq : -1);
  }

  if (droppedSeqs.length > 0) {
    events.push({
      // 捨てた行の seq を借りる。その行は入らないので、この通し番号は空いている
      seq: droppedSeqs[0] ?? -1,
      at: receivedAt,
      screen: UNKNOWN_SCREEN,
      type: "error",
      name: "dropped",
      value: droppedSeqs.length,
      detail: null,
      memberId: null,
    });
  }

  await recordEvents(
    c.env.DB,
    auth.familyId,
    {
      sessionId,
      deviceKind: auth.device?.kind ?? "user",
      deviceId: auth.device?.id ?? null,
      appVersion: toAppVersion(body.appVersion),
    },
    events,
    settings.uiLogDays,
  );

  return c.body(null, 204);
});

/** ビルドID。形が合わないものは、記録に混ぜずに落とす */
function toAppVersion(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 40) return null;
  return LABEL.test(raw) ? raw : null;
}

/**
 * 1件を保存できる形にする。通らなければ null。
 *
 * ここで例外を投げると、同じ送信に入っていた正常な行まで巻き添えで消える。
 * 落とすのはこの行だけにして、落ちたことは呼び出し側で dropped として残す。
 */
function toStored(
  event: UiEventInput,
  skew: number,
  oldest: number,
  receivedAt: number,
  knownMembers: Set<string>,
): StoredEvent | null {
  try {
    const screen = asString(event.screen, "screen", { max: 40 });
    const name = asString(event.name, "name", { max: 40 });
    if (!LABEL.test(screen) || !LABEL.test(name)) throw badRequest("screen / name の形式が不正です");
    if (typeof event.type !== "string" || !TYPES.has(event.type)) {
      throw badRequest("type が不正です");
    }

    let detail: string | null = null;
    if (event.detail !== undefined && event.detail !== null && event.detail !== "") {
      detail = asString(event.detail, "detail", { max: 60 });
      if (!LABEL.test(detail)) throw badRequest("detail の形式が不正です");
    }

    const memberId =
      typeof event.memberId === "string" && knownMembers.has(event.memberId)
        ? event.memberId
        : null;

    return {
      seq: asInt(event.seq, "seq", { min: 0, max: 100_000 }),
      // 補正しても未来には行かせない。溜め込みが長引いた古いぶんは1日前で止める
      at: Math.min(receivedAt, Math.max(oldest, asInt(event.t, "t", { min: 0 }) + skew)),
      screen,
      type: event.type,
      name,
      value: toValue(event.value, limitFor(event.type, name)),
      detail,
      memberId,
    };
  } catch {
    return null;
  }
}

/**
 * その値として「ありえる大きさ」の上限。
 *
 * 滞在時間と「1枚目まで」は可視時間なので、30分を超えていたら測り損ねている
 * (以前は一律30日だったため、39時間や29時間がそのまま集計に入っていた)。
 */
function limitFor(type: string, name: string): number {
  if (type === "leave") return MAX_DURATION;
  if (type === "flow" && name === "first-sticker") return MAX_DURATION;
  return MAX_VALUE;
}

/** 上限で丸める。開きっぱなしのタブ1つのために、送信ぶん全部を弾かない */
function toValue(raw: unknown, limit: number): number | null {
  if (raw === undefined || raw === null) return null;
  return Math.max(0, Math.min(limit, asInt(raw, "value")));
}

/** UI 改善のための集計。生のイベントは返さない */
insightsRoutes.get("/insights", requireParent, async (c) => {
  const auth = getAuth(c);
  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  const requested = c.req.query("days");
  const days = requested === undefined ? 30 : asInt(requested, "days", { min: 1, max: 365 });

  return c.json(
    await getInsights(c.env.DB, auth.familyId, {
      days,
      timeZone: await getTimeZone(c.env.DB, auth.familyId),
      retentionDays: settings.uiLogDays,
    }),
  );
});

/** 記録を今すぐ全部消す。指標を取り直したいときと、単純に残したくないとき */
insightsRoutes.delete("/ui-events", requireParent, async (c) => {
  const auth = getAuth(c);
  return c.json({ ok: true, deleted: await clearEvents(c.env.DB, auth.familyId) });
});
