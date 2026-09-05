import { toBase64Url } from "../lib/crypto";
import { badRequest, serverError } from "../lib/errors";
import type { UserIdentity } from "../db/family";

/**
 * Google の Authorization Code + PKCE フロー。
 *
 * id_token の署名検証は行わない。トークンエンドポイントを TLS 上で直接叩いて
 * 受け取ったレスポンスなので、経路そのものが真正性を担保している
 * (署名検証が必要なのは、id_token をクライアント経由で受け取る implicit 系の場合)。
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function redirectUri(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, "")}/auth/google/callback`;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = toBase64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  appOrigin: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", redirectUri(input.appOrigin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCode(input: {
  clientId: string;
  clientSecret: string;
  appOrigin: string;
  code: string;
  verifier: string;
}): Promise<UserIdentity> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(input.appOrigin),
    }),
  });

  if (!response.ok) {
    throw badRequest(`Google の認証に失敗しました (${response.status})`);
  }

  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) throw serverError("Google から id_token が返りませんでした");

  const claims = decodeJwtPayload(body.id_token);
  if (!claims.sub) throw serverError("Google の id_token に sub がありません");

  return {
    provider: "google",
    subject: claims.sub,
    email: claims.email ?? null,
    displayName: claims.name ?? claims.email ?? null,
  };
}

interface GoogleClaims {
  sub?: string;
  email?: string;
  name?: string;
}

function decodeJwtPayload(jwt: string): GoogleClaims {
  const part = jwt.split(".")[1];
  if (!part) throw serverError("id_token の形式が不正です");
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  // atob はバイト列を返すので、UTF-8 として読み直す(日本語の表示名が化けるのを防ぐ)
  const bytes = Uint8Array.from(json, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as GoogleClaims;
}
