import type { Grant, GrantResponse, Redemption, Sheet, Sticker } from "../../shared/types";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";

/**
 * 台帳・シール・交換。このアプリの中核。
 *
 * D1 にはインタラクティブトランザクションが無いので、
 * 「grant を1件作り、シールを n 枚貼り、台帳を満了させ、必要なら次の台帳を発行する」
 * という一連の書き込みは db.batch() 1回にまとめて原子的に実行する。
 * そのために ID は全て事前採番し、必要な読み取りは batch の前に済ませておく。
 *
 * 競合の検出はバージョン番号ではなく、スキーマ側の部分ユニークインデックスに任せている:
 *   stickers_slot     … 同じマスを2つの付与が取り合ったら 2つ目が落ちる
 *   sheets_one_active … 同時に次の台帳を作ろうとしたら 2つ目が落ちる
 *   sheets_member_seq … 同じ通し番号の台帳は作れない
 *   grants_request_id … 連打による二重送信が落ちる
 * batch は失敗すると全体がロールバックされるので、落ちたら読み直してやり直せばよい。
 */

// ── 行の型とマッパ ─────────────────────────────

interface SheetRow {
  id: string;
  member_id: string;
  seq_no: number;
  capacity: number;
  status: "active" | "full" | "redeemed";
  started_at: number;
  filled_at: number | null;
  redeem_requested_at: number | null;
  redeemed_at: number | null;
}

interface StickerRow {
  id: string;
  grant_id: string;
  position: number;
  art: string | null;
  created_at: number;
}

interface GrantRow {
  id: string;
  member_id: string;
  chore_id: string | null;
  chore_label: string;
  chore_emoji: string | null;
  count: number;
  note: string | null;
  created_by: string;
  created_by_name: string | null;
  created_via: "self" | "parent";
  created_at: number;
  approved_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
}

const SHEET_COLUMNS = `s.id, s.member_id, s.seq_no, s.capacity, s.status, s.started_at,
                       s.filled_at, s.redeem_requested_at, s.redeemed_at`;

const GRANT_COLUMNS = `g.id, g.member_id, g.chore_id, g.chore_label, g.chore_emoji, g.count,
                       g.note, g.created_by, m.name AS created_by_name, g.created_via,
                       g.created_at, g.approved_at, g.revoked_at, g.revoke_reason`;

function toSticker(row: StickerRow): Sticker {
  return {
    id: row.id,
    grantId: row.grant_id,
    position: row.position,
    art: row.art,
    createdAt: row.created_at,
  };
}

function toSheet(row: SheetRow, stickers: Sticker[]): Sheet {
  return {
    id: row.id,
    memberId: row.member_id,
    seqNo: row.seq_no,
    capacity: row.capacity,
    status: row.status,
    filled: stickers.length,
    startedAt: row.started_at,
    filledAt: row.filled_at,
    redeemRequestedAt: row.redeem_requested_at,
    redeemedAt: row.redeemed_at,
    stickers,
  };
}

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    memberId: row.member_id,
    choreId: row.chore_id,
    choreLabel: row.chore_label,
    choreEmoji: row.chore_emoji,
    count: row.count,
    note: row.note,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? "",
    createdVia: row.created_via,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

// ── 台帳の読み取り ─────────────────────────────

async function loadStickers(db: D1Database, sheetIds: string[]): Promise<Map<string, Sticker[]>> {
  const bySheet = new Map<string, Sticker[]>();
  for (const id of sheetIds) bySheet.set(id, []);
  if (sheetIds.length === 0) return bySheet;

  const placeholders = sheetIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, grant_id, position, art, created_at, sheet_id
         FROM stickers
        WHERE sheet_id IN (${placeholders}) AND revoked_at IS NULL
        ORDER BY position`,
    )
    .bind(...sheetIds)
    .all<StickerRow & { sheet_id: string }>();

  for (const row of results) {
    bySheet.get(row.sheet_id)?.push(toSticker(row));
  }
  return bySheet;
}

export async function loadSheets(
  db: D1Database,
  familyId: string,
  sheetIds: string[],
): Promise<Sheet[]> {
  if (sheetIds.length === 0) return [];
  const placeholders = sheetIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${SHEET_COLUMNS} FROM sheets s
        WHERE family_id = ? AND id IN (${placeholders}) ORDER BY seq_no`,
    )
    .bind(familyId, ...sheetIds)
    .all<SheetRow>();

  const stickers = await loadStickers(
    db,
    results.map((row) => row.id),
  );
  return results.map((row) => toSheet(row, stickers.get(row.id) ?? []));
}

/**
 * まだ交換されていない台帳をすべて読み、2つに分けて返す。
 *
 *   current … 各メンバーの「いま貼れる台帳」
 *   pending … 満了して、親のハンコを待っている台帳
 *
 * 繰り越しが起きると、1人が同時に2冊持つ状態になる
 * (満了した1冊目を渡しつつ、2冊目にはもう貼れる)。紙の運用と同じ。
 * current だけを返すと、渡す前の1冊目が画面から消えて交換できなくなる。
 */
export async function loadOpenSheets(
  db: D1Database,
  familyId: string,
): Promise<{ current: Record<string, Sheet>; pending: Sheet[] }> {
  const { results } = await db
    .prepare(
      // しまったメンバーの台帳は出さない(戻せば、また出てくる)
      `SELECT ${SHEET_COLUMNS} FROM sheets s
         JOIN members m ON m.id = s.member_id AND m.archived_at IS NULL
        WHERE s.family_id = ? AND s.status != 'redeemed'
        ORDER BY s.member_id, s.seq_no`,
    )
    .bind(familyId)
    .all<SheetRow>();

  const stickers = await loadStickers(
    db,
    results.map((row) => row.id),
  );
  const sheets = results.map((row) => toSheet(row, stickers.get(row.id) ?? []));

  const current: Record<string, Sheet> = {};
  for (const sheet of sheets) {
    const held = current[sheet.memberId];
    // active な台帳があればそれが「いま貼れる台帳」。
    // 無ければ(ちょうど満了して次がまだ無い場合)、いちばん新しいものを出す。
    if (!held || (held.status !== "active" && sheet.status === "active")) {
      current[sheet.memberId] = sheet;
    } else if (held.status === sheet.status && sheet.seqNo > held.seqNo) {
      current[sheet.memberId] = sheet;
    }
  }

  return { current, pending: sheets.filter((sheet) => sheet.status === "full") };
}

/** 本棚。交換済みの台帳を新しい順に返す。 */
export async function listRedeemedSheets(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<Sheet[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SHEET_COLUMNS} FROM sheets s
        WHERE family_id = ? AND member_id = ? AND status = 'redeemed'
        ORDER BY seq_no DESC`,
    )
    .bind(familyId, memberId)
    .all<SheetRow>();

  const stickers = await loadStickers(
    db,
    results.map((row) => row.id),
  );
  return results.map((row) => toSheet(row, stickers.get(row.id) ?? []));
}

async function getSheetRow(
  db: D1Database,
  familyId: string,
  sheetId: string,
): Promise<SheetRow | null> {
  return db
    .prepare(`SELECT ${SHEET_COLUMNS} FROM sheets s WHERE s.family_id = ? AND s.id = ?`)
    .bind(familyId, sheetId)
    .first<SheetRow>();
}

async function getLatestOpenSheet(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<SheetRow | null> {
  return db
    .prepare(
      `SELECT ${SHEET_COLUMNS} FROM sheets s
        WHERE family_id = ? AND member_id = ? AND status != 'redeemed'
        ORDER BY seq_no DESC LIMIT 1`,
    )
    .bind(familyId, memberId)
    .first<SheetRow>();
}

async function nextSeqNo(db: D1Database, familyId: string, memberId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(seq_no), 0) AS n FROM sheets WHERE family_id = ? AND member_id = ?")
    .bind(familyId, memberId)
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

/** active な台帳を保証する。無ければ発行する(交換直後や、移行直後の初回など)。 */
export async function ensureActiveSheet(
  db: D1Database,
  familyId: string,
  memberId: string,
  capacity: number,
): Promise<SheetRow> {
  const existing = await db
    .prepare(
      `SELECT ${SHEET_COLUMNS} FROM sheets s
        WHERE family_id = ? AND member_id = ? AND status = 'active'`,
    )
    .bind(familyId, memberId)
    .first<SheetRow>();
  if (existing) return existing;

  const id = newId("sht");
  const seqNo = await nextSeqNo(db, familyId, memberId);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sheets (id, family_id, member_id, seq_no, capacity, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(id, familyId, memberId, seqNo, capacity, now)
    .run();

  return {
    id,
    member_id: memberId,
    seq_no: seqNo,
    capacity,
    status: "active",
    started_at: now,
    filled_at: null,
    redeem_requested_at: null,
    redeemed_at: null,
  };
}

// ── シールの割り当て ───────────────────────────

export interface Allocation {
  sheetId: string;
  seqNo: number;
  capacity: number;
  isNew: boolean;
  positions: number[];
  becomesFull: boolean;
}

/**
 * n 枚のシールを、空いているマスの若い順に割り当てる。
 *
 * ここが「台帳またぎ」と「取り消しで空いた穴の埋め戻し」の両方を引き受けている。
 * 残り2マスのときに3枚貼ったら、2枚で満了 → 次の台帳を発行 → 3枚目はその1マス目、になる。
 */
export function allocate(
  start: { sheetId: string; seqNo: number; capacity: number; occupied: Set<number> },
  count: number,
  nextSheetCapacity: number,
): Allocation[] {
  if (start.capacity < 1 || nextSheetCapacity < 1) {
    throw new Error("capacity must be at least 1");
  }

  const plan: Allocation[] = [];
  let remaining = count;
  let current = { ...start, isNew: false };

  while (remaining > 0) {
    const positions: number[] = [];
    for (let p = 1; p <= current.capacity && positions.length < remaining; p++) {
      if (!current.occupied.has(p)) positions.push(p);
    }
    const filledAfter = current.occupied.size + positions.length;
    plan.push({
      sheetId: current.sheetId,
      seqNo: current.seqNo,
      capacity: current.capacity,
      isNew: current.isNew,
      positions,
      becomesFull: filledAfter >= current.capacity,
    });
    remaining -= positions.length;

    if (remaining > 0) {
      current = {
        sheetId: newId("sht"),
        seqNo: current.seqNo + 1,
        capacity: nextSheetCapacity,
        occupied: new Set<number>(),
        isNew: true,
      };
    }
  }
  return plan;
}

async function occupiedPositions(db: D1Database, sheetId: string): Promise<Set<number>> {
  const { results } = await db
    .prepare("SELECT position FROM stickers WHERE sheet_id = ? AND revoked_at IS NULL")
    .bind(sheetId)
    .all<{ position: number }>();
  return new Set(results.map((row) => row.position));
}

/**
 * grant に対してシールを発行する SQL 文を組み立てる。
 * 承認オフの家庭では付与時に、承認オンの家庭では承認時に呼ばれる。
 *
 * 文の順序が重要: sheets_one_active があるため、
 * 「いまの台帳を full にする」を「次の台帳を active で作る」より先に流す。
 */
async function buildIssueStatements(
  db: D1Database,
  familyId: string,
  grant: { id: string; memberId: string; count: number; art: string | null },
  capacity: number,
  now: number,
): Promise<{ statements: D1PreparedStatement[]; sheetIds: string[]; becameFull: boolean }> {
  const sheet = await ensureActiveSheet(db, familyId, grant.memberId, capacity);
  const occupied = await occupiedPositions(db, sheet.id);
  const plan = allocate(
    { sheetId: sheet.id, seqNo: sheet.seq_no, capacity: sheet.capacity, occupied },
    grant.count,
    capacity,
  );

  const statements: D1PreparedStatement[] = [];
  for (const entry of plan) {
    if (entry.isNew) {
      statements.push(
        db
          .prepare(
            `INSERT INTO sheets (id, family_id, member_id, seq_no, capacity, status, started_at, filled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.sheetId,
            familyId,
            grant.memberId,
            entry.seqNo,
            entry.capacity,
            entry.becomesFull ? "full" : "active",
            now,
            entry.becomesFull ? now : null,
          ),
      );
    }

    for (const position of entry.positions) {
      statements.push(
        db
          .prepare(
            `INSERT INTO stickers (id, family_id, grant_id, sheet_id, position, art, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          // 絵柄はお手伝いの絵文字。台帳を見れば「何をして貯めたか」が一目で分かる
          .bind(newId("stk"), familyId, grant.id, entry.sheetId, position, grant.art, now),
      );
    }

    if (!entry.isNew) {
      statements.push(
        entry.becomesFull
          ? db
              .prepare(
                `UPDATE sheets SET status = 'full', filled_at = ?, version = version + 1
                  WHERE family_id = ? AND id = ? AND status = 'active'`,
              )
              .bind(now, familyId, entry.sheetId)
          : db
              .prepare("UPDATE sheets SET version = version + 1 WHERE family_id = ? AND id = ?")
              .bind(familyId, entry.sheetId),
      );
    }
  }

  return {
    statements,
    sheetIds: plan.map((entry) => entry.sheetId),
    becameFull: plan.some((entry) => entry.becomesFull),
  };
}

// ── 付与 ──────────────────────────────────────

export interface CreateGrantInput {
  memberId: string;
  choreId: string | null;
  choreLabel: string;
  choreEmoji: string | null;
  count: number;
  note: string | null;
  createdBy: string;
  createdVia: "self" | "parent";
  requestId: string;
  requireApproval: boolean;
  capacity: number;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|UNIQUE|SQLITE_CONSTRAINT/i.test(message);
}

export async function getGrant(
  db: D1Database,
  familyId: string,
  grantId: string,
): Promise<Grant | null> {
  const row = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM grants g
         LEFT JOIN members m ON m.id = g.created_by
        WHERE g.family_id = ? AND g.id = ?`,
    )
    .bind(familyId, grantId)
    .first<GrantRow>();
  return row ? toGrant(row) : null;
}

async function findGrantByRequestId(
  db: D1Database,
  familyId: string,
  requestId: string,
): Promise<Grant | null> {
  const row = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM grants g
         LEFT JOIN members m ON m.id = g.created_by
        WHERE g.family_id = ? AND g.request_id = ?`,
    )
    .bind(familyId, requestId)
    .first<GrantRow>();
  return row ? toGrant(row) : null;
}

async function sheetIdsForGrant(db: D1Database, grantId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT sheet_id FROM stickers WHERE grant_id = ?")
    .bind(grantId)
    .all<{ sheet_id: string }>();
  return results.map((row) => row.sheet_id);
}

/**
 * 競合したときの待ち時間。
 *
 * 待たずに即やり直すと、競合した相手と同じタイミングで再突入して延々ぶつかり続ける。
 * 少しずつ伸ばしつつ、ばらつきを入れて再突入をずらす。
 */
const MAX_ATTEMPTS = 8;

function backoffMs(attempt: number): number {
  return Math.round((2 ** attempt) * 4 * (0.5 + Math.random()));
}

export async function createGrant(
  db: D1Database,
  familyId: string,
  input: CreateGrantInput,
): Promise<GrantResponse> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptCreateGrant(db, familyId, input);
    } catch (error) {
      // 同時に貼られてマスを取り合った、などの競合。読み直してやり直す。
      if (!isConstraintError(error)) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      }
    }
  }

  // ここに落ちるのは、家庭内利用ではまず起きない。落ちたら原因を追えるように残す。
  console.error("createGrant: 競合が解消しませんでした", {
    familyId,
    memberId: input.memberId,
    error: String(lastError),
  });
  throw conflict("シールの付与が他の操作と競合しました。もう一度お試しください");
}

async function attemptCreateGrant(
  db: D1Database,
  familyId: string,
  input: CreateGrantInput,
): Promise<GrantResponse> {
  // 連打による二重送信。既に同じ requestId で作られていたら、それをそのまま返す。
  const duplicate = await findGrantByRequestId(db, familyId, input.requestId);
  if (duplicate) {
    return {
      grant: duplicate,
      sheets: await loadSheets(db, familyId, await sheetIdsForGrant(db, duplicate.id)),
      becameFull: false,
    };
  }

  const now = Date.now();
  const grantId = newId("grt");
  const approvedAt = input.requireApproval ? null : now;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO grants (id, family_id, member_id, chore_id, chore_label, chore_emoji, count,
                             note, created_by, created_via, request_id, created_at, approved_at, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        grantId,
        familyId,
        input.memberId,
        input.choreId,
        input.choreLabel,
        input.choreEmoji,
        input.count,
        input.note,
        input.createdBy,
        input.createdVia,
        input.requestId,
        now,
        approvedAt,
        approvedAt ? input.createdBy : null,
      ),
  ];

  let sheetIds: string[] = [];
  let becameFull = false;

  if (approvedAt) {
    const issued = await buildIssueStatements(
      db,
      familyId,
      { id: grantId, memberId: input.memberId, count: input.count, art: input.choreEmoji },
      input.capacity,
      now,
    );
    statements.push(...issued.statements);
    sheetIds = issued.sheetIds;
    becameFull = issued.becameFull;
  } else {
    const open = await getLatestOpenSheet(db, familyId, input.memberId);
    if (open) sheetIds = [open.id];
  }

  if (input.choreId) {
    statements.push(
      db
        .prepare(
          `UPDATE chores SET use_count = use_count + 1, last_used_at = ?
            WHERE family_id = ? AND id = ?`,
        )
        .bind(now, familyId, input.choreId),
    );
  }

  await db.batch(statements);

  const grant = await getGrant(db, familyId, grantId);
  if (!grant) throw new Error("grant disappeared right after insert");
  return { grant, sheets: await loadSheets(db, familyId, sheetIds), becameFull };
}

/** 承認あり運用でのみ使う。承認された時点で初めてシールが発行される。 */
export async function approveGrant(
  db: D1Database,
  familyId: string,
  grantId: string,
  approvedBy: string,
  capacity: number,
): Promise<GrantResponse> {
  const grant = await getGrant(db, familyId, grantId);
  if (!grant) throw notFound("その記録は見つかりませんでした");
  if (grant.revokedAt) throw conflict("取り消し済みの記録は承認できません");
  if (grant.approvedAt) {
    return {
      grant,
      sheets: await loadSheets(db, familyId, await sheetIdsForGrant(db, grantId)),
      becameFull: false,
    };
  }

  const now = Date.now();
  const issued = await buildIssueStatements(
    db,
    familyId,
    { id: grantId, memberId: grant.memberId, count: grant.count, art: grant.choreEmoji },
    capacity,
    now,
  );

  await db.batch([
    db
      .prepare(
        `UPDATE grants SET approved_at = ?, approved_by = ?
          WHERE family_id = ? AND id = ? AND approved_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, approvedBy, familyId, grantId),
    ...issued.statements,
  ]);

  const updated = await getGrant(db, familyId, grantId);
  return {
    grant: updated ?? grant,
    sheets: await loadSheets(db, familyId, issued.sheetIds),
    becameFull: issued.becameFull,
  };
}

/**
 * 付与の取り消し。行は消さず、シールを無効化してマスに穴を空ける。
 * 満了扱いだった台帳は、穴が空いたぶん active に戻す。
 * ただし交換済みの台帳には触れない(渡してしまったものは取り消せない)。
 */
export async function revokeGrant(
  db: D1Database,
  familyId: string,
  grantId: string,
  revokedBy: string,
  reason: string | null,
): Promise<{ grant: Grant; sheets: Sheet[] }> {
  const grant = await getGrant(db, familyId, grantId);
  if (!grant) throw notFound("その記録は見つかりませんでした");
  if (grant.revokedAt) {
    return { grant, sheets: await loadSheets(db, familyId, await sheetIdsForGrant(db, grantId)) };
  }

  const sheetIds = await sheetIdsForGrant(db, grantId);
  if (sheetIds.length > 0) {
    const placeholders = sheetIds.map(() => "?").join(", ");
    const redeemed = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM sheets
          WHERE family_id = ? AND id IN (${placeholders}) AND status = 'redeemed'`,
      )
      .bind(familyId, ...sheetIds)
      .first<{ n: number }>();
    if ((redeemed?.n ?? 0) > 0) {
      throw conflict("交換ずみの台帳のシールは取り消せません");
    }
  }

  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
          WHERE family_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .bind(now, revokedBy, reason, familyId, grantId),
    db
      .prepare(
        "UPDATE stickers SET revoked_at = ? WHERE family_id = ? AND grant_id = ? AND revoked_at IS NULL",
      )
      .bind(now, familyId, grantId),
  ]);

  await reopenLatestSheetIfNeeded(db, familyId, grant.memberId);

  const updated = await getGrant(db, familyId, grantId);
  return { grant: updated ?? grant, sheets: await loadSheets(db, familyId, sheetIds) };
}

/**
 * 取り消しでマスが空いたら、その子の最新の台帳を active に戻す。
 *
 * active に戻せるのは「最新の未交換の台帳」だけ。
 * sheets_one_active があるので、古い台帳を勝手に active に戻すことはできない
 * (繰り越しで新しい台帳が既に始まっている場合、古い方は full のままにしておく)。
 */
async function reopenLatestSheetIfNeeded(
  db: D1Database,
  familyId: string,
  memberId: string,
): Promise<void> {
  const latest = await getLatestOpenSheet(db, familyId, memberId);
  if (!latest || latest.status !== "full") return;

  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM stickers WHERE sheet_id = ? AND revoked_at IS NULL")
    .bind(latest.id)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= latest.capacity) return;

  try {
    await db
      .prepare(
        `UPDATE sheets
            SET status = 'active', filled_at = NULL, redeem_requested_at = NULL, version = version + 1
          WHERE family_id = ? AND id = ? AND status = 'full'`,
      )
      .bind(familyId, latest.id)
      .run();
  } catch (error) {
    // 読み取ってから更新するまでの間に、別の付与が次の台帳を始めていた場合。
    // sheets_one_active に弾かれるが、それは「開け直さないのが正しい」ということなので、
    // 取り消し自体は成功として扱う。
    if (!isConstraintError(error)) throw error;
  }
}

// ── 履歴 ──────────────────────────────────────

export async function listGrants(
  db: D1Database,
  familyId: string,
  options: { memberId?: string; limit?: number; includeRevoked?: boolean } = {},
): Promise<Grant[]> {
  const conditions = ["g.family_id = ?"];
  const values: Array<string | number> = [familyId];
  if (options.memberId) {
    conditions.push("g.member_id = ?");
    values.push(options.memberId);
  }
  if (options.includeRevoked === false) {
    conditions.push("g.revoked_at IS NULL");
  }

  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM grants g
         LEFT JOIN members m ON m.id = g.created_by
        WHERE ${conditions.join(" AND ")}
        ORDER BY g.created_at DESC
        LIMIT ?`,
    )
    .bind(...values, Math.min(options.limit ?? 100, 500))
    .all<GrantRow>();
  return results.map(toGrant);
}

/**
 * 承認待ちの申請。
 * 承認なし運用の家庭では常に空になるので、問い合わせても無駄にはならない。
 */
export async function listPendingGrants(db: D1Database, familyId: string): Promise<Grant[]> {
  const { results } = await db
    .prepare(
      // しまったメンバーの申請は、承認待ちに出さない
      `SELECT ${GRANT_COLUMNS} FROM grants g
         LEFT JOIN members m ON m.id = g.created_by
         JOIN members target ON target.id = g.member_id AND target.archived_at IS NULL
        WHERE g.family_id = ? AND g.approved_at IS NULL AND g.revoked_at IS NULL
        ORDER BY g.created_at`,
    )
    .bind(familyId)
    .all<GrantRow>();
  return results.map(toGrant);
}

// ── 交換 ──────────────────────────────────────

export async function requestRedeem(
  db: D1Database,
  familyId: string,
  sheetId: string,
): Promise<Sheet> {
  const sheet = await getSheetRow(db, familyId, sheetId);
  if (!sheet) throw notFound("その台帳は見つかりませんでした");
  if (sheet.status !== "full") throw conflict("まだ台帳がいっぱいになっていません");

  if (!sheet.redeem_requested_at) {
    await db
      .prepare(
        `UPDATE sheets SET redeem_requested_at = ?, version = version + 1
          WHERE family_id = ? AND id = ? AND status = 'full' AND redeem_requested_at IS NULL`,
      )
      .bind(Date.now(), familyId, sheetId)
      .run();
  }

  const sheets = await loadSheets(db, familyId, [sheetId]);
  if (!sheets[0]) throw notFound("その台帳は見つかりませんでした");
  return sheets[0];
}

export interface RedeemInput {
  rewardText: string;
  category: string | null;
  amountYen: number | null;
  approvedBy: string;
  capacity: number;
}

/**
 * 親のハンコ。台帳を交換済みにして本棚へ送り、次の台帳を発行する。
 */
export async function redeemSheet(
  db: D1Database,
  familyId: string,
  sheetId: string,
  input: RedeemInput,
): Promise<{ sheet: Sheet; nextSheet: Sheet | null; redemption: Redemption }> {
  const sheet = await getSheetRow(db, familyId, sheetId);
  if (!sheet) throw notFound("その台帳は見つかりませんでした");
  if (sheet.status === "redeemed") throw conflict("その台帳はすでに交換ずみです");
  if (sheet.status !== "full") throw conflict("まだ台帳がいっぱいになっていません");

  const now = Date.now();
  const redemptionId = newId("rdm");

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO redemptions (id, family_id, sheet_id, member_id, reward_text, category,
                                  amount_yen, requested_at, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        redemptionId,
        familyId,
        sheetId,
        sheet.member_id,
        input.rewardText,
        input.category,
        input.amountYen,
        sheet.redeem_requested_at,
        input.approvedBy,
        now,
      ),
    db
      .prepare(
        `UPDATE sheets SET status = 'redeemed', redeemed_at = ?, version = version + 1
          WHERE family_id = ? AND id = ? AND status = 'full'`,
      )
      .bind(now, familyId, sheetId),
  ];

  // 繰り越しで既に次の台帳が始まっていることがあるので、無いときだけ発行する
  const openSheet = await db
    .prepare(
      `SELECT id FROM sheets
        WHERE family_id = ? AND member_id = ? AND status != 'redeemed' AND id != ?
        LIMIT 1`,
    )
    .bind(familyId, sheet.member_id, sheetId)
    .first<{ id: string }>();

  let nextSheetId: string | null = openSheet?.id ?? null;
  if (!openSheet) {
    nextSheetId = newId("sht");
    statements.push(
      db
        .prepare(
          `INSERT INTO sheets (id, family_id, member_id, seq_no, capacity, status, started_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .bind(
          nextSheetId,
          familyId,
          sheet.member_id,
          await nextSeqNo(db, familyId, sheet.member_id),
          input.capacity,
          now,
        ),
    );
  }

  await db.batch(statements);

  const loaded = await loadSheets(
    db,
    familyId,
    nextSheetId ? [sheetId, nextSheetId] : [sheetId],
  );
  const redeemedSheet = loaded.find((s) => s.id === sheetId);
  if (!redeemedSheet) throw notFound("その台帳は見つかりませんでした");

  return {
    sheet: redeemedSheet,
    nextSheet: loaded.find((s) => s.id === nextSheetId) ?? null,
    redemption: {
      id: redemptionId,
      sheetId,
      memberId: sheet.member_id,
      seqNo: sheet.seq_no,
      rewardText: input.rewardText,
      category: input.category,
      amountYen: input.amountYen,
      approvedAt: now,
      approvedByName: "",
    },
  };
}

export async function listRedemptions(
  db: D1Database,
  familyId: string,
  memberId?: string,
): Promise<Redemption[]> {
  const conditions = ["r.family_id = ?"];
  const values: string[] = [familyId];
  if (memberId) {
    conditions.push("r.member_id = ?");
    values.push(memberId);
  }

  const { results } = await db
    .prepare(
      `SELECT r.id, r.sheet_id, r.member_id, s.seq_no, r.reward_text, r.category,
              r.amount_yen, r.approved_at, m.name AS approved_by_name
         FROM redemptions r
         JOIN sheets s ON s.id = r.sheet_id
         LEFT JOIN members m ON m.id = r.approved_by
        WHERE ${conditions.join(" AND ")}
        ORDER BY r.approved_at DESC`,
    )
    .bind(...values)
    .all<{
      id: string;
      sheet_id: string;
      member_id: string;
      seq_no: number;
      reward_text: string;
      category: string | null;
      amount_yen: number | null;
      approved_at: number;
      approved_by_name: string | null;
    }>();

  return results.map((row) => ({
    id: row.id,
    sheetId: row.sheet_id,
    memberId: row.member_id,
    seqNo: row.seq_no,
    rewardText: row.reward_text,
    category: row.category,
    amountYen: row.amount_yen,
    approvedAt: row.approved_at,
    approvedByName: row.approved_by_name ?? "",
  }));
}
