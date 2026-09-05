/**
 * VAPID 鍵を作る。
 *
 *   npm run vapid
 *
 * 出た値を、ローカルは .dev.vars に、本番は wrangler secret put で入れる。
 * 秘密鍵は git に入れない。
 */
import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

const toBase64Url = (buffer) =>
  Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const publicKey = toBase64Url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
