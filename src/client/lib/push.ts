import { api, errorCode } from "../api";
import { trackError } from "./telemetry";

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

/**
 * 許可を求めて購読し、サーバに登録する。断られたら false。
 *
 * pushManager.subscribe() は、鍵が壊れている・プッシュサービスに拒否された・
 * Service Worker がまだ有効になっていない、といった理由で普通に失敗する。
 * 失敗しても子ども側でできることは無いので、投げっぱなしにせず false に丸める。
 * ここで例外を上に投げると、バナーのボタンが押せる状態のまま残ってしまい、
 * 同じ失敗を繰り返し踏ませることになる。
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!canUsePush()) return false;

  try {
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
  } catch (cause) {
    trackError(errorCode(cause), "push-subscribe");
    return false;
  }
}
