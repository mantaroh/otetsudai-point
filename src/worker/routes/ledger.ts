import { Hono } from "hono";
import type {
  AuthInfo,
  BootstrapResponse,
  GrantRequest,
  RedeemRequest,
} from "../../shared/types";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { asInt, asOptionalInt, asOptionalString, asString, readJson } from "../lib/validate";
import { getFamily, getMember, getSettings, listMembers, resolveParentMemberId } from "../db/family";
import { getChore, listChores, upsertChoreByName } from "../db/chores";
import {
  approveGrant,
  createGrant,
  getGrant,
  listGrants,
  listRedemptions,
  listPendingGrants,
  listRedeemedSheets,
  loadOpenSheets,
  redeemSheet,
  requestRedeem,
  revokeGrant,
} from "../db/ledger";
import { assertParent, getAuth, requireParent } from "../auth/middleware";
import type { AppContext } from "../types";
import type { AppBindings } from "../types";

/** 台帳・シール・交換。アプリの本体。 */
export const ledgerRoutes = new Hono<AppBindings>();

/**
 * 子端末は自分以外のメンバーを触れない。
 * 「存在しない」と「見る権限がない」を区別せずに 404 を返す。
 */
async function loadMemberOr404(c: AppContext, memberId: string) {
  const auth = getAuth(c);
  if (auth.lockedMemberId && auth.lockedMemberId !== memberId) throw notFound();

  const member = await getMember(c.env.DB, auth.familyId, memberId);
  if (!member) throw notFound();
  return member;
}

// ── 起動時の一括取得 ───────────────────────────

ledgerRoutes.get("/bootstrap", async (c) => {
  const auth = getAuth(c);
  const [family, settings, members, chores, open, pendingGrants] = await Promise.all([
    getFamily(c.env.DB, auth.familyId),
    getSettings(c.env.DB, auth.familyId),
    listMembers(c.env.DB, auth.familyId),
    listChores(c.env.DB, auth.familyId),
    loadOpenSheets(c.env.DB, auth.familyId),
    listPendingGrants(c.env.DB, auth.familyId),
  ]);
  if (!family || !settings) throw notFound();

  const authInfo: AuthInfo = {
    kind: auth.kind,
    lockedMemberId: auth.lockedMemberId,
    canActAsParent: auth.canActAsParent,
    needsPin: !auth.canActAsParent,
    userDisplayName:
      members.find((member) => member.id === auth.parentMemberId)?.name ?? null,
  };

  const visibleMembers = settings.siblingsVisible
    ? members
    : members.filter(
        (member) => member.role === "parent" || member.id === auth.lockedMemberId || !auth.lockedMemberId,
      );

  // 子ども専用端末には、その子のぶんだけを渡す
  const visibleSheet = (memberId: string) =>
    !auth.lockedMemberId || auth.lockedMemberId === memberId;

  const response: BootstrapResponse = {
    family,
    settings,
    members: visibleMembers,
    chores,
    sheets: Object.fromEntries(
      Object.entries(open.current).filter(([memberId]) => visibleSheet(memberId)),
    ),
    pendingSheets: open.pending.filter((sheet) => visibleSheet(sheet.memberId)),
    pendingGrants: pendingGrants.filter((grant) => visibleSheet(grant.memberId)),
    auth: authInfo,
  };
  return c.json(response);
});

// ── 台帳・履歴の読み取り ───────────────────────

ledgerRoutes.get("/members/:memberId/sheets", async (c) => {
  const auth = getAuth(c);
  const member = await loadMemberOr404(c, c.req.param("memberId"));
  return c.json(await listRedeemedSheets(c.env.DB, auth.familyId, member.id));
});

ledgerRoutes.get("/members/:memberId/history", async (c) => {
  const auth = getAuth(c);
  const member = await loadMemberOr404(c, c.req.param("memberId"));
  const limit = asOptionalInt(c.req.query("limit"), "limit", { min: 1, max: 500 }) ?? 100;
  return c.json(await listGrants(c.env.DB, auth.familyId, { memberId: member.id, limit }));
});

ledgerRoutes.get("/members/:memberId/redemptions", async (c) => {
  const auth = getAuth(c);
  const member = await loadMemberOr404(c, c.req.param("memberId"));
  return c.json(await listRedemptions(c.env.DB, auth.familyId, member.id));
});

/** 親画面のタイムライン(家族全員ぶん) */
ledgerRoutes.get("/history", requireParent, async (c) => {
  const auth = getAuth(c);
  const limit = asOptionalInt(c.req.query("limit"), "limit", { min: 1, max: 500 }) ?? 100;
  return c.json(await listGrants(c.env.DB, auth.familyId, { limit }));
});

// ── シールを貼る ───────────────────────────────

ledgerRoutes.post("/grants", async (c) => {
  const auth = getAuth(c);
  const body = await readJson<GrantRequest & { asParent?: boolean }>(c.req.raw);

  const member = await loadMemberOr404(c, asString(body.memberId, "memberId", { max: 64 }));
  if (member.role !== "child") throw badRequest("シールを貼れるのは子どもの台帳だけです");

  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  // 誰の操作として記録するかを決める。クライアントの自己申告は使わない。
  const wantsParent = body.asParent === true || auth.kind === "user" || auth.device?.kind === "parent";
  let createdBy = member.id;
  let createdVia: "self" | "parent" = "self";

  if (wantsParent) {
    await assertParent(c);
    const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
    if (!parentMemberId) throw badRequest("親のメンバーが登録されていません");
    createdBy = parentMemberId;
    createdVia = "parent";
  } else if (!settings.allowSelfGrant) {
    throw forbidden("この家庭では、シールを貼れるのはおうちの人だけです");
  }

  const count = asInt(body.count, "枚数", { min: 1, max: 50 });
  const requestId = asString(body.requestId, "requestId", { min: 8, max: 64 });

  // メニューから選ばれたか、「そのほか」で入力されたか。
  // 入力されたものはここでメニューに追加され、以後は兄弟どちらの選択肢にも出る。
  let choreId: string | null = null;
  let choreLabel: string;
  let choreEmoji: string | null = null;

  if (body.choreId) {
    const chore = await getChore(c.env.DB, auth.familyId, asString(body.choreId, "choreId", { max: 64 }));
    if (!chore) throw notFound("そのお手伝いは見つかりませんでした");
    choreId = chore.id;
    choreLabel = chore.name;
    choreEmoji = chore.emoji;
  } else if (body.choreName) {
    const chore = await upsertChoreByName(
      c.env.DB,
      auth.familyId,
      asString(body.choreName, "お手伝いの名前", { max: 40 }),
      createdBy,
    );
    choreId = chore.id;
    choreLabel = chore.name;
    choreEmoji = chore.emoji;
  } else {
    throw badRequest("お手伝いを選んでください");
  }

  const result = await createGrant(c.env.DB, auth.familyId, {
    memberId: member.id,
    choreId,
    choreLabel,
    choreEmoji,
    count,
    note: asOptionalString(body.note, "メモ", { max: 200 }),
    createdBy,
    createdVia,
    requestId,
    requireApproval: settings.requireApproval && createdVia === "self",
    capacity: settings.capacity,
  });

  return c.json(result, 201);
});

/** 承認あり運用の家庭でのみ使う */
ledgerRoutes.post("/grants/:grantId/approve", requireParent, async (c) => {
  const auth = getAuth(c);
  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  if (!parentMemberId) throw badRequest("親のメンバーが登録されていません");

  return c.json(
    await approveGrant(
      c.env.DB,
      auth.familyId,
      c.req.param("grantId"),
      parentMemberId,
      settings.capacity,
    ),
  );
});

/**
 * 取り消し。
 * 直後の押し間違いは子でも戻せるが、それを過ぎたぶんは親の操作。
 */
ledgerRoutes.post("/grants/:grantId/revoke", async (c) => {
  const auth = getAuth(c);
  const grantId = c.req.param("grantId");
  const grant = await getGrant(c.env.DB, auth.familyId, grantId);
  if (!grant) throw notFound();
  if (auth.lockedMemberId && auth.lockedMemberId !== grant.memberId) throw notFound();

  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  const withinGrace =
    grant.createdVia === "self" &&
    grant.createdBy === grant.memberId &&
    Date.now() - grant.createdAt <= settings.selfRevokeSec * 1000;

  let revokedBy = grant.memberId;
  if (!withinGrace) {
    await assertParent(c);
    const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
    if (!parentMemberId) throw badRequest("親のメンバーが登録されていません");
    revokedBy = parentMemberId;
  }

  const body = await readJson<{ reason?: unknown }>(c.req.raw).catch(() => ({ reason: null }));
  const reason = asOptionalString(body.reason, "理由", { max: 200 });

  return c.json(await revokeGrant(c.env.DB, auth.familyId, grantId, revokedBy, reason));
});

// ── 交換 ──────────────────────────────────────

/** 子から親への「こうかんしたい」 */
ledgerRoutes.post("/sheets/:sheetId/request-redeem", async (c) => {
  const auth = getAuth(c);
  const sheet = await requestRedeem(c.env.DB, auth.familyId, c.req.param("sheetId"));
  if (auth.lockedMemberId && auth.lockedMemberId !== sheet.memberId) throw notFound();
  return c.json(sheet);
});

/** 親のハンコ。台帳を本棚に送り、次の台帳を発行する。 */
ledgerRoutes.post("/sheets/:sheetId/redeem", requireParent, async (c) => {
  const auth = getAuth(c);
  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  if (!parentMemberId) throw badRequest("親のメンバーが登録されていません");

  const body = await readJson<RedeemRequest>(c.req.raw);
  return c.json(
    await redeemSheet(c.env.DB, auth.familyId, c.req.param("sheetId"), {
      rewardText: asString(body.rewardText, "交換したもの", { max: 100 }),
      category: asOptionalString(body.category, "カテゴリ", { max: 20 }),
      amountYen: asOptionalInt(body.amountYen, "金額", { min: 0, max: 1_000_000 }),
      approvedBy: parentMemberId,
      capacity: settings.capacity,
    }),
  );
});

ledgerRoutes.get("/redemptions", async (c) => {
  const auth = getAuth(c);
  return c.json(await listRedemptions(c.env.DB, auth.familyId));
});
