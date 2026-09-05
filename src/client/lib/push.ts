import { api } from "../api";

/**
 * Web Push の購読。
 *
 * iOS / iPadOS では、ホーム画面に追加した PWA でしか PushManager が生えない。
 * Safari のタブで開いているときは window.PushManager が無いので、
 * 個別の OS 判定を書かなくても canUsePush() が false になる。
 *
 * 「押したのに何も起きない」が一番わかりにくいので、
 * 使えない端末にはボタンそのものを出さない。
 */

export function canUsePush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): NotificationPermission | "unsupported" {
  if (!canUsePush()) return "unsupported";
  return Notification.permission;
}

/** VAPID の公開鍵は base64url。subscribe() は Uint8Array しか受け取らない。 */
function decodeKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** 許可を求めて購読し、サーバに登録する。断られたら false。 */
export async function subscribeToPush(): Promise<boolean> {
  if (!canUsePush()) return false;

  const { publicKey } = await api.pushConfig();
  if (!publicKey) return false;

  if ((await Notification.requestPermission()) !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });

  const json = subscription.toJSON();
  await api.subscribePush({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  });
  return true;
}
