import { Hono } from "hono";
import type { DeviceKind } from "../../shared/types";
import { badRequest, notFound } from "../lib/errors";
import { appOrigin } from "../lib/origin";
import { asOptionalString, asString, readJson } from "../lib/validate";
import { createInvite, listDevices, revokeDevice, updateDevice } from "../db/devices";
import { getMember, resolveParentMemberId } from "../db/family";
import { getAuth, requireParent } from "../auth/middleware";
import type { AppBindings } from "../types";

/** 端末の招待と失効。すべて親操作。 */
export const deviceRoutes = new Hono<AppBindings>();

const KINDS: DeviceKind[] = ["shared", "child", "parent"];

deviceRoutes.get("/devices", requireParent, async (c) => {
  const auth = getAuth(c);
  return c.json(await listDevices(c.env.DB, auth.familyId));
});

/**
 * 招待リンクの発行。
 * 返す URL は 30分で失効し、一度使うと無効になる。
 */
deviceRoutes.post("/devices/invites", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ kind?: unknown; memberId?: unknown; label?: unknown }>(c.req.raw);

  const kind = asString(body.kind, "端末の種類", { max: 10 }) as DeviceKind;
  if (!KINDS.includes(kind)) throw badRequest("端末の種類が不正です");

  const memberIdInput = asOptionalString(body.memberId, "memberId", { max: 64 });
  let memberId: string | null = null;
  if (memberIdInput) {
    // 他家庭のメンバーIDを渡されても、ここで弾かれる
    const member = await getMember(c.env.DB, auth.familyId, memberIdInput);
    if (!member) throw badRequest("そのメンバーは見つかりませんでした");
    memberId = member.id;
  }
  if (kind === "parent" && !memberId) {
    memberId = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  }

  const createdBy = await resolveParentMemberId(c.env.DB, auth.familyId, auth.parentMemberId);
  if (!createdBy) throw badRequest("親のメンバーが登録されていません");

  const { token, expiresAt } = await createInvite(c.env.DB, auth.familyId, {
    kind,
    memberId,
    label: asString(body.label, "端末の名前", { max: 40 }),
    createdBy,
  });

  return c.json({ url: `${appOrigin(c)}/invite/${token}`, expiresAt }, 201);
});

/** 端末の名前を変える。どれを失効させるか判断できるように、実態と合わせておきたい */
deviceRoutes.patch("/devices/:deviceId", requireParent, async (c) => {
  const auth = getAuth(c);
  const body = await readJson<{ label?: unknown }>(c.req.raw);

  const device = await updateDevice(c.env.DB, auth.familyId, c.req.param("deviceId"), {
    ...(body.label !== undefined ? { label: asString(body.label, "端末の名前", { max: 40 }) } : {}),
  });
  if (!device) throw notFound();

  return c.json({
    id: device.id,
    label: device.label,
    kind: device.kind,
    memberId: device.memberId,
    skipPin: device.skipPin,
  });
});

deviceRoutes.delete("/devices/:deviceId", requireParent, async (c) => {
  const auth = getAuth(c);
  await revokeDevice(c.env.DB, auth.familyId, c.req.param("deviceId"));
  return c.json({ ok: true });
});
