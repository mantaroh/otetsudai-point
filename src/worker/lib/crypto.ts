/**
 * Workers の WebCrypto だけで完結する暗号ユーティリティ。
 * Node の crypto や外部ライブラリには依存しない。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * 端末トークン・招待トークンのハッシュ化。
 * トークン自体が 256bit の乱数なので、辞書攻撃の余地がなく SHA-256 一発でよい。
 * (PIN のような低エントロピーの秘密には使わないこと)
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

/** タイミング攻撃を避ける固定時間比較 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacRaw(secret: string, data: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
  return new Uint8Array(signature);
}

async function hmac(secret: string, data: string): Promise<string> {
  return toBase64Url(await hmacRaw(secret, data));
}

/**
 * 任意の JSON を署名付き文字列にする。Cookie の中身はクライアントから読めるが、
 * 改竄はできない(サーバ側に状態を持たずに済む)。
 */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyPayload<T>(secret: string, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!timingSafeEqual(signature, await hmac(secret, body))) return null;
  try {
    return JSON.parse(decoder.decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}

/**
 * PIN のハッシュ化。
 *
 * ## なぜ反復回数が少ないのか
 *
 * Workers には1リクエストあたりの CPU 時間の上限がある(無料プランで 10ms)。
 * PBKDF2 は Workers 上で 21万回 = 112ms かかり、上限を大きく超えてランタイムに落とされる。
 * 実際、これで家庭の作成が本番で 500 になっていた。
 *
 * ## 何で守っているのか
 *
 * 反復回数の代わりに **ペッパー**(サーバ側だけが持つ秘密鍵)を使う。
 * PIN を先に HMAC に通してから KDF にかけるので、
 * D1 の中身やバックアップだけが漏れても、PIN の候補を試すことすらできない。
 * 鍵は Cloudflare のシークレットにあり、データベースには入らない。
 *
 * そもそも 4 桁の PIN は、鍵まで揃った相手には反復回数をいくら上げても守れない
 * (10^4 通りしかなく、21万回でも総当たりは十数分で終わる)。
 * 実質的な防御は、オンラインでの試行回数制限(5回でロック)のほう。
 * つまりこの変更で失うものはほとんど無く、ペッパーが増えたぶんむしろ厚くなっている。
 */
const PIN_SCHEME = "pbkdf2p";
const PIN_ITERATIONS = 2_000;

export async function hashPin(pin: string, pepper: string): Promise<string> {
  // 保存側は逆に、鍵が無いなら黙って弱いものを書かずに落とす
  if (!pepper) throw new Error("PIN のハッシュ化に必要な鍵がありません");

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePin(pin, pepper, salt, PIN_ITERATIONS);
  return `${PIN_SCHEME}$${PIN_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
  // 鍵が無い状態で検証を通してしまうより、通さないほうが安全。
  // (そもそも SESSION_SECRET が無ければアプリは起動しない)
  if (!pepper) return false;

  const [scheme, iterations, salt, expected] = stored.split("$");
  if (scheme !== PIN_SCHEME || !iterations || !salt || !expected) return false;

  const rounds = Number(iterations);
  // 保存値の反復回数をそのまま信じると、細工された値で CPU を焼き切られる
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50_000) return false;

  const actual = await derivePin(pin, pepper, fromBase64Url(salt), rounds);
  return timingSafeEqual(toBase64Url(actual), expected);
}

async function derivePin(
  pin: string,
  pepper: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  // 先にサーバ側の秘密鍵を混ぜる。ここが KDF の弱さを埋めている
  const peppered = await hmacRaw(pepper, pin);
  const key = await crypto.subtle.importKey("raw", peppered as BufferSource, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}
