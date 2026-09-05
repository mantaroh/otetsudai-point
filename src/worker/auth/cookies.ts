import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signPayload, verifyPayload } from "../lib/crypto";
import type { AppContext } from "../types";

export const COOKIE = {
  /** 親の OAuth セッション */
  session: "op_s",
  /** 複数の家庭に属している場合の、操作対象の家庭 */
  family: "op_f",
  /** 共有タブレット・子端末の端末トークン */
  device: "op_d",
  /** PIN 検証済みチケット(短命) */
  pin: "op_pin",
  /** OAuth の state / PKCE */
  oauth: "op_oauth",
} as const;

const DAY = 86_400;
export const SESSION_TTL_SEC = 30 * DAY;
export const DEVICE_TTL_SEC = 365 * DAY;
export const PIN_TICKET_TTL_SEC = 15 * 60;
export const OAUTH_TTL_SEC = 10 * 60;

export interface SessionPayload {
  uid: string;
  exp: number;
}
export interface FamilyPayload {
  fid: string;
  exp: number;
}
export interface PinTicketPayload {
  fid: string;
  exp: number;
}
export interface OAuthPayload {
  state: string;
  verifier: string;
  exp: number;
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function baseOptions(c: Context, maxAge: number) {
  return {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

async function put(c: AppContext, name: string, payload: unknown, ttl: number): Promise<void> {
  const value = await signPayload(c.env.SESSION_SECRET, payload);
  setCookie(c, name, value, baseOptions(c, ttl));
}

async function take<T extends { exp: number }>(c: AppContext, name: string): Promise<T | null> {
  const payload = await verifyPayload<T>(c.env.SESSION_SECRET, getCookie(c, name));
  if (!payload || payload.exp < nowSec()) return null;
  return payload;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export const setSessionCookie = (c: AppContext, userId: string) =>
  put(c, COOKIE.session, { uid: userId, exp: nowSec() + SESSION_TTL_SEC }, SESSION_TTL_SEC);
export const readSessionCookie = (c: AppContext) => take<SessionPayload>(c, COOKIE.session);

export const setFamilyCookie = (c: AppContext, familyId: string) =>
  put(c, COOKIE.family, { fid: familyId, exp: nowSec() + SESSION_TTL_SEC }, SESSION_TTL_SEC);
export const readFamilyCookie = (c: AppContext) => take<FamilyPayload>(c, COOKIE.family);

export const setPinTicket = (c: AppContext, familyId: string) =>
  put(c, COOKIE.pin, { fid: familyId, exp: nowSec() + PIN_TICKET_TTL_SEC }, PIN_TICKET_TTL_SEC);
export const readPinTicket = (c: AppContext) => take<PinTicketPayload>(c, COOKIE.pin);

export const setOAuthCookie = (c: AppContext, state: string, verifier: string) =>
  put(c, COOKIE.oauth, { state, verifier, exp: nowSec() + OAUTH_TTL_SEC }, OAUTH_TTL_SEC);
export const readOAuthCookie = (c: AppContext) => take<OAuthPayload>(c, COOKIE.oauth);

export function setDeviceCookie(c: AppContext, token: string): void {
  setCookie(c, COOKIE.device, token, baseOptions(c, DEVICE_TTL_SEC));
}
export const readDeviceCookie = (c: AppContext) => getCookie(c, COOKIE.device);

export function clearAuthCookies(c: AppContext): void {
  for (const name of Object.values(COOKIE)) {
    deleteCookie(c, name, { path: "/" });
  }
}
