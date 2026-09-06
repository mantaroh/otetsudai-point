import { Hono } from "hono";
import type { CreateFamilyRequest, FamilySettings } from "../../shared/types";
import { badRequest, conflict, forbidden, notFound, serverError, unauthorized } from "../lib/errors";
import {
  asColor,
  asInt,
  asOptionalBool,
  asOptionalInt,
  asOptionalString,
  asPin,
  asString,
  readJson,
} from "../lib/validate";
import {
  archiveMember,
  checkFamilyPin,
  countActiveMembers,
  createFamily,
  createMember,
  getAnyMember,
  getMembership,
  getSettings,
  listArchivedMembers,
  listMembers,
  memberHasRecords,
  purgeMember,
  restoreMember,
  setFamilyPin,
  updateMember,
  updateSettings,
  type MemberPatch,
} from "../db/family";
import { getAuth, requireParent } from "../auth/middleware";
import { readSessionCookie, setFamilyCookie, setPinTicket } from "../auth/cookies";
import type { AppBindings } from "../types";

/**
 * まだどの家庭にも属していない状態で呼ばれるルート。
 * 家庭スコープの認証(requireAuth)を通す前に置く必要がある。
 */
export const familySetupRoutes = new Hono<AppBindings>();

/** 家庭の作成・切り替え・設定・PIN。 */
export const familyRoutes = new Hono<AppBindings>();

/**
 * 家庭の新規作成(オンボーディング)。
 * ここだけは familyId ではなく、ログイン中のユーザーを起点にする。
 */
familySetupRoutes.post("/families", async (c) => {
  const session = await readSessionCookie(c);
  if (!session) throw unauthorized("家庭を作るにはログインが必要です");

  const body = await readJson<CreateFamilyRequest>(c.req.raw);
  const children = Array.isArray(body.children) ? body.children : [];
  if (children.length === 0) throw badRequest("お子さんを1人以上登録してください");
  if (children.length > 10) throw badRequest("お子さんは10人までです");

  const { familyId } = await createFamily(c.env.DB, {
    familyName: asString(body.familyName, "家族の名前", { max: 40 }),
    pin: asPin(body.pin),
    parentName: asString(body.parentName, "親の名前", { max: 20 }),
    children: children.map((child, index) => ({
      name: asString(child.name, `${index + 1}人目の名前`, { max: 20 }),
      avatar: child.avatar,
      color: child.color,
    })),
    capacity: asOptionalInt(body.capacity, "台帳のマス数", { min: 1, max: 200 }) ?? 30,
    userId: session.uid,
    pepper: c.env.SESSION_SECRET,
  });

  await setFamilyCookie(c, familyId);
  return c.json({ familyId }, 201);
});

/** 複数の家庭に属している場合の切り替え。 */
familySetupRoutes.post("/session/family", async (c) => {
  const session = await readSessionCookie(c);
  if (!session) throw unauthorized();

  const body = await readJson<{ familyId?: unknown }>(c.req.raw);
  const familyId = asString(body.familyId, "familyId", { max: 64 });

  // 本人がその家庭に属していることを必ず確かめてから Cookie を書き換える
  const membership = await getMembership(c.env.DB, session.uid, familyId);
  if (!membership) throw notFound();

  await setFamilyCookie(c, familyId);
  return c.json({ ok: true, familyId });
});

/**
 * PIN の事前検証。
 * 親操作のたびに PIN を打たせないよう、UI から先にこれを叩いて短命チケットを取る。
 */
familyRoutes.post("/pin/verify", async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ pin?: unknown }>(c.req.raw);
  const result = await checkFamilyPin(
    c.env.DB,
    auth.familyId,
    asPin(body.pin),
    c.env.SESSION_SECRET,
  );

  if (!result.ok) {
    return c.json(
      {
        ok: false,
        lockedUntil: result.lockedUntil,
        message: result.lockedUntil
          ? "続けて間違えたため、しばらくロックされています"
          : "PIN が違います",
      },
      401,
    );
  }

  await setPinTicket(c, auth.familyId);
  return c.json({ ok: true });
});

familyRoutes.post("/pin", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ pin?: unknown }>(c.req.raw);
  await setFamilyPin(c.env.DB, auth.familyId, asPin(body.pin), c.env.SESSION_SECRET);
  await setPinTicket(c, auth.familyId);
  return c.json({ ok: true });
});

/** 家族を増やす。子どもなら、その場で1冊目の台帳も発行される */
familyRoutes.post("/members", requireParent, async (c) => {
  const auth = getAuth(c);
  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();

  const body = await readJson<{
    name?: unknown;
    role?: unknown;
    avatar?: unknown;
    color?: unknown;
  }>(c.req.raw);

  const role = body.role === "parent" ? "parent" : "child";
  const members = await listMembers(c.env.DB, auth.familyId);
  if (members.length >= 20) throw badRequest("これ以上は増やせません");

  const member = await createMember(c.env.DB, auth.familyId, {
    name: asString(body.name, "名前", { max: 20 }),
    role,
    avatar: asOptionalString(body.avatar, "アイコン", { max: 8 }) ?? (role === "child" ? "🙂" : "👤"),
    color: body.color === undefined ? nextColor(members) : asColor(body.color, "いろ"),
    capacity: settings.capacity,
  });
  if (!member) throw serverError("メンバーを追加できませんでした");
  return c.json(member, 201);
});

/** 追加時の色は、いま使われていないものから選んで重複を避ける */
function nextColor(members: Array<{ color: string | null }>): string {
  const used = new Set(members.map((member) => member.color));
  return CHILD_COLORS.find((color) => !used.has(color)) ?? CHILD_COLORS[0]!;
}

const CHILD_COLORS = ["#ff8fab", "#5bc0eb", "#9bc53d", "#fa9f42", "#a06cd5"];

/** しまってあるメンバー。せってい画面から戻せるようにするため */
familyRoutes.get("/members/archived", requireParent, async (c) => {
  const auth = getAuth(c);
  return c.json(await listArchivedMembers(c.env.DB, auth.familyId));
});

/**
 * 家族を減らす。
 *
 * 既定は「しまう」。記録は残したまま一覧から外すだけなので、あとから戻せる。
 * 完全に消せるのは、まだ何の記録も無いメンバーだけ
 * (間違えて追加したときのための逃げ道)。
 * シールや交換の記録があるメンバーを消せてしまうと、取り返しがつかない。
 */
familyRoutes.delete("/members/:memberId", requireParent, async (c) => {
  const auth = getAuth(c);
  const memberId = c.req.param("memberId");
  // すでにしまってある人を完全に消すこともあるので、活動中に限らず引く
  const found = await getAnyMember(c.env.DB, auth.familyId, memberId);
  if (!found) throw notFound();
  const { member, archived } = found;

  // 最後の1人を外すと、その役割が家庭から消えて操作できなくなる。
  // すでにしまってある人は、外しても活動中の人数は減らない
  if (!archived) {
    const remaining = await countActiveMembers(c.env.DB, auth.familyId, member.role);
    if (remaining <= 1) {
      throw conflict(
        member.role === "child"
          ? "お子さんが1人もいなくなってしまいます"
          : "おうちの人が1人もいなくなってしまいます",
      );
    }
  }

  if (c.req.query("purge") === "1") {
    if (await memberHasRecords(c.env.DB, auth.familyId, memberId)) {
      throw conflict("記録が残っているので完全には削除できません。「しまう」を使ってください");
    }
    await purgeMember(c.env.DB, auth.familyId, memberId);
    return c.json({ ok: true, purged: true });
  }

  await archiveMember(c.env.DB, auth.familyId, memberId);
  return c.json({ ok: true, purged: false });
});

/** しまったメンバーを戻す */
familyRoutes.post("/members/:memberId/restore", requireParent, async (c) => {
  const auth = getAuth(c);
  const member = await restoreMember(c.env.DB, auth.familyId, c.req.param("memberId"));
  if (!member) throw notFound();
  return c.json(member);
});

/**
 * メンバーの表示情報を変える。
 * 名前は変わることがある(呼び名が変わる、あだ名にする、下の子が自分で決める)。
 */
familyRoutes.patch("/members/:memberId", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ name?: unknown; avatar?: unknown; color?: unknown }>(c.req.raw);

  const patch: MemberPatch = {};
  if (body.name !== undefined) patch.name = asString(body.name, "名前", { max: 20 });
  if (body.avatar !== undefined) patch.avatar = asOptionalString(body.avatar, "アイコン", { max: 8 });
  if (body.color !== undefined) patch.color = asColor(body.color, "いろ");

  const member = await updateMember(c.env.DB, auth.familyId, c.req.param("memberId"), patch);
  if (!member) throw notFound();
  return c.json(member);
});

familyRoutes.get("/settings", async (c) => {
  const auth = getAuth(c);
  const settings = await getSettings(c.env.DB, auth.familyId);
  if (!settings) throw notFound();
  return c.json(settings);
});

familyRoutes.patch("/settings", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<Partial<FamilySettings>>(c.req.raw);

  const patch: Partial<FamilySettings> = {};
  if (body.capacity !== undefined) {
    patch.capacity = asInt(body.capacity, "台帳のマス数", { min: 1, max: 200 });
  }
  if (body.selfRevokeSec !== undefined) {
    patch.selfRevokeSec = asInt(body.selfRevokeSec, "自分で取り消せる時間", { min: 0, max: 86_400 });
  }
  if (body.uiLogDays !== undefined) {
    patch.uiLogDays = asInt(body.uiLogDays, "操作記録の保持日数", { min: 0, max: 365 });
  }
  const requireApproval = asOptionalBool(body.requireApproval, "requireApproval");
  if (requireApproval !== undefined) patch.requireApproval = requireApproval;
  const allowSelfGrant = asOptionalBool(body.allowSelfGrant, "allowSelfGrant");
  if (allowSelfGrant !== undefined) patch.allowSelfGrant = allowSelfGrant;
  const siblingsVisible = asOptionalBool(body.siblingsVisible, "siblingsVisible");
  if (siblingsVisible !== undefined) patch.siblingsVisible = siblingsVisible;

  await updateSettings(c.env.DB, auth.familyId, patch);
  return c.json(await getSettings(c.env.DB, auth.familyId));
});

/**
 * 家庭の全データを JSON で書き出す。
 * 「いつでも自分のデータを持ち出せる」ことは、他人の家庭の記録を預かる前提条件。
 */
familyRoutes.get("/export", requireParent, async (c) => {
  const auth = getAuth(c);
  const tables = [
    "families",
    "family_settings",
    "members",
    "chores",
    "sheets",
    "grants",
    "stickers",
    "redemptions",
    "ui_events",
    "bonus_rules",
    "push_subscriptions",
    "push_sends",
  ] as const;

  const data: Record<string, unknown[]> = {};
  for (const table of tables) {
    const column = table === "families" ? "id" : "family_id";
    const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
      .bind(auth.familyId)
      .all();
    data[table] = results;
  }
  // PIN のハッシュは書き出さない
  data.families = (data.families as Array<Record<string, unknown>>).map(
    ({ pin_hash: _pin, pin_failed_count: _c, pin_locked_until: _l, ...rest }) => rest,
  );

  return c.json({ exportedAt: Date.now(), familyId: auth.familyId, data });
});

/** 家庭の削除。owner だけが実行でき、その家庭の行を本当に消す。 */
familyRoutes.delete("/families/:familyId", requireParent, async (c) => {
  const auth = getAuth(c);
  // URL の familyId は「意図した家庭かどうかの確認」にだけ使い、スコープは auth から取る
  if (c.req.param("familyId") !== auth.familyId) throw notFound();
  if (auth.membershipRole !== "owner") throw forbidden("家庭を削除できるのは作成者だけです");

  const familyId = auth.familyId;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ui_events WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM stickers WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM redemptions WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM grants WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM sheets WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM chores WHERE family_id = ?").bind(familyId),
    // bonus_rules.created_by と push_subscriptions.device_id/member_id が
    // members/devices を参照するため、その削除より前に消す
    c.env.DB.prepare("DELETE FROM bonus_rules WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM push_subscriptions WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM push_sends WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM device_invites WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM devices WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM memberships WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM members WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM family_settings WHERE family_id = ?").bind(familyId),
    c.env.DB.prepare("DELETE FROM families WHERE id = ?").bind(familyId),
  ]);

  return c.json({ ok: true });
});
