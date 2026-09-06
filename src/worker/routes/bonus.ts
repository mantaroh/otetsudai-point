import { Hono } from "hono";
import type { BonusRuleInput } from "../../shared/types";
import { badRequest } from "../lib/errors";
import { asInt, asString, readJson } from "../lib/validate";
import { resolveParentMemberId } from "../db/family";
import {
  addRule,
  disableToday,
  enableToday,
  getState,
  listRules,
  removeRule,
} from "../db/bonus";
import { getAuth, requireParent } from "../auth/middleware";
import { notifyBonus } from "../lib/notify";
import type { AppBindings } from "../types";

/**
 * ポイント2倍デー。設定できるのは親だけ。
 * 今日が2倍かどうかの読み取りは bootstrap から返すので、ここは親向けの設定 API に絞る。
 */
export const bonusRoutes = new Hono<AppBindings>();

bonusRoutes.get("/bonus", requireParent, async (c) => {
  const auth = getAuth(c);
  const [state, rules] = await Promise.all([
    getState(c.env.DB, auth.familyId, Date.now()),
    listRules(c.env.DB, auth.familyId),
  ]);
  return c.json({ state, rules });
});

bonusRoutes.post("/bonus/today", requireParent, async (c) => {
  const auth = getAuth(c);
  const now = Date.now();
  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  const state = await enableToday(c.env.DB, auth.familyId, now, parentMemberId);
  // 送信そのものが失敗しても、2倍の設定は成立させる
  const notified = await notifyBonus(c.env, auth.familyId, now).catch((error) => {
    console.error("2倍デーの通知に失敗", { familyId: auth.familyId, error: String(error) });
    return false;
  });
  return c.json({ state, notified });
});

bonusRoutes.delete("/bonus/today", requireParent, async (c) => {
  const auth = getAuth(c);
  const state = await disableToday(c.env.DB, auth.familyId, Date.now());
  return c.json({ state });
});

bonusRoutes.post("/bonus/rules", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ kind?: unknown; weekday?: unknown; dayOfMonth?: unknown }>(
    c.req.raw,
  );
  const kind = asString(body.kind, "kind", { max: 16 });

  let input: BonusRuleInput;
  if (kind === "weekly") {
    input = { kind, weekday: asInt(body.weekday, "曜日", { min: 0, max: 6 }) };
  } else if (kind === "monthly") {
    input = { kind, dayOfMonth: asInt(body.dayOfMonth, "日にち", { min: 1, max: 31 }) };
  } else {
    throw badRequest("毎週か毎月かを選んでください");
  }

  const parentMemberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  const rule = await addRule(c.env.DB, auth.familyId, input, parentMemberId);
  return c.json({ rule }, 201);
});

bonusRoutes.delete("/bonus/rules/:ruleId", requireParent, async (c) => {
  const auth = getAuth(c);
  await removeRule(c.env.DB, auth.familyId, asString(c.req.param("ruleId"), "ruleId", { max: 64 }));
  return c.json({ ok: true });
});
