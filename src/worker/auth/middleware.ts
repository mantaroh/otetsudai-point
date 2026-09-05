import type { MiddlewareHandler } from "hono";
import { pinRequired, tooManyRequests, unauthorized } from "../lib/errors";
import { checkFamilyPin, getMembership, listFamiliesForUser } from "../db/family";
import { findDeviceByToken, touchDevice } from "../db/devices";
import type { AppBindings, AppContext, AuthContext } from "../types";
import { readDeviceCookie, readFamilyCookie, readPinTicket, readSessionCookie, setPinTicket } from "./cookies";

/**
 * この1リクエストの実効権限を確定させる。
 *
 * ここが唯一の familyId の出どころ。以降のハンドラは getAuth(c).familyId しか見ない。
 * URL やリクエストボディに書かれた家庭IDを信用してはいけない(他家庭のデータが漏れる)。
 */
export const resolveAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = (await resolveFromSession(c)) ?? (await resolveFromDevice(c));
  if (auth) c.set("auth", auth);
  await next();
};

async function resolveFromSession(c: AppContext): Promise<AuthContext | null> {
  const session = await readSessionCookie(c);
  if (!session) return null;

  const cookieFamily = await readFamilyCookie(c);
  let familyId = cookieFamily?.fid ?? null;
  if (!familyId) {
    // 家庭が未選択なら、所属している最初の家庭を既定にする
    const families = await listFamiliesForUser(c.env.DB, session.uid);
    familyId = families[0]?.id ?? null;
  }
  if (!familyId) return null;

  // Cookie の家庭IDが本当にそのユーザーのものかは、必ずここで確かめる
  const membership = await getMembership(c.env.DB, session.uid, familyId);
  if (!membership) return null;

  return {
    familyId,
    kind: "user",
    userId: session.uid,
    membershipRole: membership.role,
    parentMemberId: membership.member_id,
    device: null,
    lockedMemberId: null,
    canActAsParent: membership.role === "owner" || membership.role === "parent",
  };
}

async function resolveFromDevice(c: AppContext): Promise<AuthContext | null> {
  const token = readDeviceCookie(c);
  if (!token) return null;

  const device = await findDeviceByToken(c.env.DB, token);
  if (!device) return null;

  c.executionCtx.waitUntil(touchDevice(c.env.DB, device.id));

  return {
    familyId: device.familyId,
    kind: "device",
    userId: null,
    membershipRole: null,
    parentMemberId: device.kind === "parent" ? device.memberId : null,
    device: { id: device.id, kind: device.kind, memberId: device.memberId },
    lockedMemberId: device.kind === "child" ? device.memberId : null,
    canActAsParent: device.kind === "parent" && device.skipPin,
  };
}

export function getAuth(c: AppContext): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  return auth;
}

/** 認証済みであることだけを要求する(閲覧・子の操作) */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  getAuth(c);
  await next();
};

/**
 * 親操作を要求する。
 *
 * 通る条件は3つのいずれか:
 *   1. OAuth ログイン済みで、その家庭の owner / parent である
 *   2. skip_pin を許可した親端末である
 *   3. 正しい PIN が提示された(または直近15分の PIN チケットが有効)
 */
export async function assertParent(c: AppContext): Promise<void> {
  const auth = getAuth(c);
  if (auth.canActAsParent) return;

  const ticket = await readPinTicket(c);
  if (ticket && ticket.fid === auth.familyId) return;

  const pin = c.req.header("X-Parent-Pin");
  if (!pin) throw pinRequired();

  const result = await checkFamilyPin(c.env.DB, auth.familyId, pin, c.env.SESSION_SECRET);
  if (result.ok) {
    // 続けて何度も PIN を打たせないよう、短命のチケットを発行する
    await setPinTicket(c, auth.familyId);
    return;
  }
  if (result.lockedUntil) {
    throw tooManyRequests("PIN の入力を続けて間違えたため、しばらくロックされています");
  }
  throw pinRequired("PIN が違います");
}

export const requireParent: MiddlewareHandler<AppBindings> = async (c, next) => {
  await assertParent(c);
  await next();
};
