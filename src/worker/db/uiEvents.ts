import type {
  DailyUsage,
  MemberUsage,
  NamedCount,
  ScreenUsage,
  UiInsights,
} from "../../shared/types";

/**
 * 画面の操作記録。
 *
 * 台帳のデータと違って、これは「消さずに残す」対象ではない。
 * UI を直すための指標として見る窓のぶんだけ持ち、それより古いものは捨てる
 * (保持日数は family_settings.ui_log_days)。
 *
 * db/ 配下の規約どおり、全関数が familyId を第一引数に取り、
 * SQL には必ず WHERE family_id = ? を含める。
 */

export interface StoredEvent {
  seq: number;
  /** 時計のずれを補正済みの発生時刻 */
  at: number;
  screen: string;
  type: string;
  name: string;
  value: number | null;
  detail: string | null;
  memberId: string | null;
}

/**
 * 記録の出どころ。イベント1件ごとではなく、送信1回ごとに決まる。
 *
 * deviceId と appVersion は「記録が来ていないのはどの端末か」「その端末が
 * いつのビルドで動いているか」を見るために持つ。どちらもこちら側で払い出した
 * 固定の識別子で、UserAgent のような端末そのものの情報ではない。
 */
export interface EventContext {
  sessionId: string;
  deviceKind: string | null;
  deviceId: string | null;
  appVersion: string | null;
}

/**
 * 1回の送信ぶんをまとめて書き込む。
 *
 * (session_id, seq) の UNIQUE で、再送されても二重に数えない。
 * D1 には「1クエリあたり100個」の変数上限があるので、複数行 INSERT ではなく
 * 1イベント1文の batch にしてある。
 */
export async function recordEvents(
  db: D1Database,
  familyId: string,
  context: EventContext,
  events: StoredEvent[],
  retentionDays: number,
): Promise<void> {
  if (events.length === 0) return;
  const now = Date.now();

  const statements = events.map((event) =>
    db
      .prepare(
        `INSERT INTO ui_events
           (family_id, session_id, seq, at, screen, type, name, value, detail, member_id,
            device_kind, device_id, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, seq) DO NOTHING`,
      )
      .bind(
        familyId,
        context.sessionId,
        event.seq,
        event.at,
        event.screen,
        event.type,
        event.name,
        event.value,
        event.detail,
        event.memberId,
        context.deviceKind,
        context.deviceId,
        context.appVersion,
        now,
      ),
  );

  // 保持期間を過ぎた行は、書き込みのついでに落とす。
  // (family_id, at) のインデックスが効くので、ふだんは0行の空振りで終わる。
  // 掃除のためだけに Cron を1本増やすより、こちらのほうが仕組みが少ない。
  statements.push(
    db
      .prepare("DELETE FROM ui_events WHERE family_id = ? AND at < ?")
      .bind(familyId, now - retentionDays * 86_400_000),
  );

  await db.batch(statements);
}

/**
 * その家庭に実在するメンバーID。
 *
 * 送られてきた memberId をそのまま入れると、他家庭のIDを混ぜられたときに
 * 外部キー違反で 500 になったり、集計に見知らぬIDが並んだりする。
 * ここで引いた集合に無いものは、記録側で NULL に落とす。
 * しまってある人も対象に含める(その人の記録も集計には出したい)。
 */
export async function listMemberIds(db: D1Database, familyId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT id FROM members WHERE family_id = ?")
    .bind(familyId)
    .all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

/** せってい画面の「記録を消す」。指標をリセットしたいときにも使う */
export async function clearEvents(db: D1Database, familyId: string): Promise<number> {
  const result = await db.prepare("DELETE FROM ui_events WHERE family_id = ?").bind(familyId).run();
  return result.meta.changes ?? 0;
}

// ── 集計 ──────────────────────────────────────

/** 中央値・パーセンタイル。標本が少ないので、SQL でやらずに JS で素直に出す */
export function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? null;
}

/**
 * SQLite は名前付きタイムゾーンを知らないので、オフセットを modifier にして渡す。
 * 期間の途中で夏時間が切り替わる地域では日境界が1時間ずれるが、
 * 「どの日によく使われたか」を見る用途では実害が無い範囲として割り切る。
 */
export function tzOffsetModifier(timeZone: string, at: number): string {
  let minutes = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(at));
    const label = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label);
    if (match) {
      const sign = match[1] === "-" ? -1 : 1;
      minutes = sign * (Number(match[2]) * 60 + Number(match[3]));
    }
  } catch {
    // 設定に壊れたタイムゾーン名が入っていても、集計そのものは UTC で出す
  }
  return `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
}

interface CountRow {
  name: string;
  screen: string | null;
  detail: string | null;
  n: number;
}

/** 中央値を出すために生値のまま持ってくる行 */
interface ValueRow {
  name: string | null;
  value: number;
}

export async function getInsights(
  db: D1Database,
  familyId: string,
  options: { days: number; timeZone: string; retentionDays: number },
): Promise<UiInsights> {
  const from = Date.now() - options.days * 86_400_000;
  const dayModifier = tzOffsetModifier(options.timeZone, from);
  const scope = [familyId, from] as const;

  const batch = await db.batch([
    // 0: 全体
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
           FROM ui_events WHERE family_id = ? AND at >= ?`,
      )
      .bind(...scope),

    // 1: 画面ごとの表示回数
    db
      .prepare(
        `SELECT screen AS name,
                SUM(CASE WHEN type = 'view' THEN 1 ELSE 0 END) AS n,
                COUNT(DISTINCT session_id) AS sessions
           FROM ui_events WHERE family_id = ? AND at >= ?
          GROUP BY screen ORDER BY n DESC, sessions DESC`,
      )
      .bind(...scope),

    // 2: よく押されたもの
    db
      .prepare(
        `SELECT name, NULL AS screen, NULL AS detail, COUNT(*) AS n
           FROM ui_events WHERE family_id = ? AND at >= ? AND type = 'action'
          GROUP BY name ORDER BY n DESC LIMIT 30`,
      )
      .bind(...scope),

    // 3: つまずき
    db
      .prepare(
        `SELECT name, screen, detail, COUNT(*) AS n
           FROM ui_events WHERE family_id = ? AND at >= ? AND type = 'friction'
          GROUP BY name, screen, detail ORDER BY n DESC LIMIT 30`,
      )
      .bind(...scope),

    // 4: エラー
    db
      .prepare(
        `SELECT name, screen, detail, COUNT(*) AS n
           FROM ui_events WHERE family_id = ? AND at >= ? AND type = 'error'
          GROUP BY name, screen, detail ORDER BY n DESC LIMIT 20`,
      )
      .bind(...scope),

    // 5: 台帳を開いたセッションのうち、どこまで進んだか。
    //    セッション単位で数えるので、1回の訪問で何枚貼っても1と数える
    db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN type = 'view' AND screen = 'ledger'
                               THEN session_id END) AS opened,
           COUNT(DISTINCT CASE WHEN type = 'action' AND name = 'chore-pick'
                               THEN session_id END) AS picked,
           COUNT(DISTINCT CASE WHEN type = 'action' AND name = 'stick'
                               THEN session_id END) AS stuck
           FROM ui_events WHERE family_id = ? AND at >= ?`,
      )
      .bind(...scope),

    // 6: 子ごと
    db
      .prepare(
        `SELECT member_id AS name,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(CASE WHEN type = 'action' AND name = 'stick' THEN 1 ELSE 0 END) AS sticks,
                SUM(CASE WHEN type = 'action' AND name = 'undo' THEN 1 ELSE 0 END) AS undos,
                SUM(CASE WHEN type = 'friction' THEN 1 ELSE 0 END) AS frictions
           FROM ui_events
          WHERE family_id = ? AND at >= ? AND member_id IS NOT NULL
          GROUP BY member_id`,
      )
      .bind(...scope),

    // 7: 日ごと
    db
      .prepare(
        `SELECT date(at / 1000, 'unixepoch', ?) AS name,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(CASE WHEN type = 'action' AND name = 'stick' THEN 1 ELSE 0 END) AS sticks
           FROM ui_events WHERE family_id = ? AND at >= ?
          GROUP BY name ORDER BY name`,
      )
      .bind(dayModifier, ...scope),

    // 8〜10: 中央値を出すための生値。
    //        家庭ぶんの標本しか無いので、上限を切って持ってきて JS で丸める
    db
      .prepare(
        `SELECT screen AS name, value FROM ui_events
          WHERE family_id = ? AND at >= ? AND type = 'leave' AND value IS NOT NULL
          ORDER BY id DESC LIMIT 4000`,
      )
      .bind(...scope),

    db
      .prepare(
        `SELECT member_id AS name, value FROM ui_events
          WHERE family_id = ? AND at >= ? AND type = 'flow'
            AND name = 'first-sticker' AND value IS NOT NULL
          ORDER BY id DESC LIMIT 2000`,
      )
      .bind(...scope),

    db
      .prepare(
        `SELECT NULL AS name, value FROM ui_events
          WHERE family_id = ? AND at >= ? AND type = 'flow'
            AND name = 'first-sticker-taps' AND value IS NOT NULL
          ORDER BY id DESC LIMIT 2000`,
      )
      .bind(...scope),
  ]);

  /** batch の結果は「必ず11個ある」と型で言えないので、取り出しはここに寄せる */
  const rows = <T>(index: number): T[] => (batch[index]?.results ?? []) as unknown as T[];

  const totals = rows<{ sessions: number; events: number }>(0)[0];
  const funnel = rows<{ opened: number; picked: number; stuck: number }>(5)[0];

  const dwellByScreen = groupValues(rows<ValueRow>(8));
  const firstStickers = rows<ValueRow>(9);
  const firstByMember = groupValues(firstStickers);
  const firstAll = firstStickers.map((row) => row.value);

  return {
    days: options.days,
    from,
    retentionDays: options.retentionDays,
    sessions: totals?.sessions ?? 0,
    events: totals?.events ?? 0,

    screens: rows<CountRow & { sessions: number }>(1).map(
      (row): ScreenUsage => ({
        screen: row.name,
        views: row.n,
        sessions: row.sessions,
        medianDwellMs: percentile(dwellByScreen.get(row.name) ?? [], 0.5),
      }),
    ),

    actions: toCounts(rows<CountRow>(2)),
    frictions: toCounts(rows<CountRow>(3)),
    errors: toCounts(rows<CountRow>(4)),

    funnel: {
      opened: funnel?.opened ?? 0,
      picked: funnel?.picked ?? 0,
      stuck: funnel?.stuck ?? 0,
    },

    firstSticker: {
      samples: firstAll.length,
      p50Ms: percentile(firstAll, 0.5),
      p90Ms: percentile(firstAll, 0.9),
      medianTaps: percentile(
        rows<ValueRow>(10).map((row) => row.value),
        0.5,
      ),
    },

    members: rows<{
      name: string;
      sessions: number;
      sticks: number;
      undos: number;
      frictions: number;
    }>(6).map(
      (row): MemberUsage => ({
        memberId: row.name,
        sessions: row.sessions,
        sticks: row.sticks,
        undos: row.undos,
        frictions: row.frictions,
        medianFirstStickerMs: percentile(firstByMember.get(row.name) ?? [], 0.5),
      }),
    ),

    daily: rows<{ name: string; sessions: number; sticks: number }>(7).map(
      (row): DailyUsage => ({ date: row.name, sessions: row.sessions, sticks: row.sticks }),
    ),
  };
}

function toCounts(list: CountRow[]): NamedCount[] {
  return list.map((row) => ({
    name: row.name,
    screen: row.screen,
    detail: row.detail,
    count: row.n,
  }));
}

function groupValues(list: ValueRow[]): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const row of list) {
    if (row.name === null) continue;
    const bucket = grouped.get(row.name);
    if (bucket) bucket.push(row.value);
    else grouped.set(row.name, [row.value]);
  }
  return grouped;
}
