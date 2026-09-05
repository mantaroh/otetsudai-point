import { Hono } from "hono";
import { notFound } from "../lib/errors";
import { asInt, asOptionalBool, asOptionalString, asString, readJson } from "../lib/validate";
import { listChores, updateChore, upsertChoreByName } from "../db/chores";
import { getAuth, requireParent } from "../auth/middleware";
import type { AppBindings } from "../types";

/** お手伝いメニュー。並び順は使用頻度で、よく使うものが上に来る。 */
export const choreRoutes = new Hono<AppBindings>();

choreRoutes.get("/chores", async (c) => {
  const auth = getAuth(c);
  return c.json(await listChores(c.env.DB, auth.familyId));
});

/**
 * メニューへの追加。
 * シールを貼るときの「そのほか」からも同じ経路が呼ばれるので、
 * ここは親操作にしない(子が入力したものもそのままメニューに載る)。
 */
choreRoutes.post("/chores", async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ name?: unknown; emoji?: unknown }>(c.req.raw);
  const chore = await upsertChoreByName(
    c.env.DB,
    auth.familyId,
    asString(body.name, "お手伝いの名前", { max: 40 }),
    auth.parentMemberId,
    asOptionalString(body.emoji, "絵文字", { max: 8 }),
  );
  return c.json(chore, 201);
});

choreRoutes.patch("/chores/:choreId", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{
    name?: unknown;
    emoji?: unknown;
    defaultCount?: unknown;
    archived?: unknown;
  }>(c.req.raw);

  const chore = await updateChore(c.env.DB, auth.familyId, c.req.param("choreId"), {
    ...(body.name !== undefined ? { name: asString(body.name, "お手伝いの名前", { max: 40 }) } : {}),
    ...(body.emoji !== undefined ? { emoji: asOptionalString(body.emoji, "絵文字", { max: 8 }) } : {}),
    ...(body.defaultCount !== undefined
      ? { defaultCount: asInt(body.defaultCount, "めやす枚数", { min: 1, max: 50 }) }
      : {}),
    ...(body.archived !== undefined
      ? { archived: asOptionalBool(body.archived, "archived") ?? false }
      : {}),
  });
  if (!chore) throw notFound();
  return c.json(chore);
});
