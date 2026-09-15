import type {
  BonusRule,
  BonusRuleInput,
  BonusState,
  BootstrapResponse,
  Chore,
  CreateFamilyRequest,
  FamilySettings,
  Grant,
  GrantRequest,
  GrantResponse,
  MeResponse,
  Member,
  RedeemRequest,
  Redemption,
  Sheet,
  UiInsights,
} from "../shared/types";
import { trackError } from "./lib/telemetry";

/**
 * API クライアント。
 *
 * 親操作で PIN が必要になったときは PinRequiredError を投げる。
 * 呼び出し側はそれを捕まえて PIN 入力を出し、通ったら同じ操作をもう一度実行する。
 *
 * 失敗の記録もここで行う。画面ごとの catch に任せていたときは、
 * 台帳データの取得そのものが失敗した場合(= 画面が出ないまま終わる)が
 * どこにも残らなかった。ここに置けば、書き忘れる余地が無い。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class PinRequiredError extends ApiError {}

/** 失敗を記録するときのコード。想定外の例外でも何かしらの名前を返す */
export function errorCode(cause: unknown): string {
  return cause instanceof ApiError ? cause.code : "unknown";
}

/**
 * 記録に載せる操作名。
 *
 * URL からは作らない。招待リンクのトークンやIDが混ざる余地を残さないため、
 * ここで名前を決めた固定の識別子だけを使う(DESIGN.md 9.2)。
 * 引数で必ず受け取るので、新しい API を足すときに名前を付け忘れられない。
 */
type Operation = string;

type Options = RequestInit & { pin?: string };

async function request<T>(op: Operation, path: string, init?: Options): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  if (init?.pin) headers.set("X-Parent-Pin", init.pin);

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  } catch (cause) {
    // つながらなかった。画面が出ないまま終わることが多く、いちばん見えなくなりやすい失敗
    trackError("network", op);
    throw cause;
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (payload as { error?: string } | null)?.error ?? "error";
    const message =
      (payload as { message?: string } | null)?.message ?? "エラーが発生しました";
    // PIN を求められただけなら失敗ではない。ここを混ぜると
    // 「子どもの前で失敗した回数」を映さなくなる
    if (code === "pin_required") throw new PinRequiredError(response.status, code, message);
    trackError(code, op);
    throw new ApiError(response.status, code, message);
  }
  return payload as T;
}

const post = <T>(op: Operation, path: string, body?: unknown, pin?: string) =>
  request<T>(op, path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    pin,
  });

export const api = {
  me: () => request<MeResponse>("me", "/me"),
  bootstrap: () => request<BootstrapResponse>("bootstrap", "/bootstrap"),

  /** ローカル開発専用。本番では 404 が返る */
  devSignIn: (): Promise<{ ok: boolean; needsSetup: boolean }> =>
    fetch("/auth/dev", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((response) => response.json() as Promise<{ ok: boolean; needsSetup: boolean }>),
  signOut: () => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }),

  /** 招待リンクの中身を見るだけ(消費しない) */
  peekInvite: (token: string) =>
    request<{
      status: "ok" | "used" | "expired" | "unknown";
      familyName: string | null;
      label: string | null;
      kind: "shared" | "child" | "parent" | null;
      memberName: string | null;
    }>("invite-peek", `/invites/${encodeURIComponent(token)}`),
  /** 招待リンクを引き換えて、この端末を登録する */
  claimInvite: (token: string) =>
    post<{ ok: true }>("invite-claim", `/invites/${encodeURIComponent(token)}/claim`),

  createFamily: (body: CreateFamilyRequest) =>
    post<{ familyId: string }>("family-create", "/families", body),
  switchFamily: (familyId: string) =>
    post<{ ok: true }>("family-switch", "/session/family", { familyId }),

  verifyPin: (pin: string) => post<{ ok: true }>("pin-verify", "/pin/verify", { pin }),
  /** 新しい PIN を設定する。いまの PIN(または OAuth ログイン)で認証される */
  changePin: (newPin: string, pin?: string) =>
    post<{ ok: true }>("pin-change", "/pin", { pin: newPin }, pin),
  exportData: (pin?: string) => request<Record<string, unknown>>("export", "/export", { pin }),

  updateMember: (
    memberId: string,
    patch: { name?: string; avatar?: string; color?: string },
    pin?: string,
  ) =>
    request<Member>("member-update", `/members/${memberId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      pin,
    }),
  addMember: (
    body: { name: string; role: "child" | "parent"; avatar?: string; color?: string },
    pin?: string,
  ) => post<Member>("member-add", "/members", body, pin),
  /** 既定は「しまう」(記録は残る)。purge を指定すると完全に消す(記録が無い場合だけ) */
  removeMember: (memberId: string, options: { purge?: boolean } = {}, pin?: string) =>
    request<{ ok: true; purged: boolean }>(
      "member-remove",
      `/members/${memberId}${options.purge ? "?purge=1" : ""}`,
      { method: "DELETE", pin },
    ),
  restoreMember: (memberId: string, pin?: string) =>
    post<Member>("member-restore", `/members/${memberId}/restore`, undefined, pin),
  archivedMembers: (pin?: string) =>
    request<Member[]>("member-archived", "/members/archived", { pin }),

  chores: () => request<Chore[]>("chores", "/chores"),
  addChore: (name: string, emoji?: string) =>
    post<Chore>("chore-add", "/chores", { name, emoji }),
  updateChore: (choreId: string, patch: Partial<Chore> & { archived?: boolean }, pin?: string) =>
    request<Chore>("chore-update", `/chores/${choreId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      pin,
    }),

  /** 画面に見えている並びを丸ごと送る。並びが古ければ 409 が返る */
  reorderChores: (choreIds: string[], pin?: string) =>
    request<Chore[]>("chore-reorder", "/chores/order", {
      method: "PUT",
      body: JSON.stringify({ choreIds }),
      pin,
    }),

  grant: (body: GrantRequest & { asParent?: boolean }, pin?: string) =>
    post<GrantResponse>("stick", "/grants", body, pin),
  revokeGrant: (grantId: string, reason?: string, pin?: string) =>
    post<{ grant: Grant; sheets: Sheet[] }>(
      "grant-revoke",
      `/grants/${grantId}/revoke`,
      { reason },
      pin,
    ),
  approveGrant: (grantId: string, pin?: string) =>
    post<GrantResponse>("grant-approve", `/grants/${grantId}/approve`, undefined, pin),

  history: (memberId?: string, limit = 100) =>
    request<Grant[]>(
      "history",
      memberId ? `/members/${memberId}/history?limit=${limit}` : `/history?limit=${limit}`,
    ),
  shelf: (memberId: string) => request<Sheet[]>("shelf", `/members/${memberId}/sheets`),
  redemptions: (memberId?: string) =>
    request<Redemption[]>(
      "redemptions",
      memberId ? `/members/${memberId}/redemptions` : "/redemptions",
    ),

  requestRedeem: (sheetId: string) =>
    post<Sheet>("redeem-request", `/sheets/${sheetId}/request-redeem`),
  redeem: (sheetId: string, body: RedeemRequest, pin?: string) =>
    post<{ sheet: Sheet; nextSheet: Sheet | null }>(
      "redeem",
      `/sheets/${sheetId}/redeem`,
      body,
      pin,
    ),

  /** 画面の操作記録の集計(親のみ) */
  insights: (days: number, pin?: string) =>
    request<UiInsights>("insights", `/insights?days=${days}`, { pin }),
  clearUiEvents: (pin?: string) =>
    request<{ ok: true; deleted: number }>("ui-log-clear", "/ui-events", {
      method: "DELETE",
      pin,
    }),

  settings: () => request<FamilySettings>("settings", "/settings"),
  updateSettings: (patch: Partial<FamilySettings>, pin?: string) =>
    request<FamilySettings>("settings-update", "/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
      pin,
    }),

  bonus: (pin?: string) =>
    request<{ state: BonusState; rules: BonusRule[] }>("bonus", "/bonus", { pin }),
  enableBonusToday: (pin?: string) =>
    post<{ state: BonusState; notified: boolean }>("bonus-today-on", "/bonus/today", undefined, pin),
  disableBonusToday: (pin?: string) =>
    request<{ state: BonusState }>("bonus-today-off", "/bonus/today", { method: "DELETE", pin }),
  addBonusRule: (input: BonusRuleInput, pin?: string) =>
    post<{ rule: BonusRule }>("bonus-rule-add", "/bonus/rules", input, pin),
  removeBonusRule: (ruleId: string, pin?: string) =>
    request<{ ok: true }>("bonus-rule-remove", `/bonus/rules/${ruleId}`, {
      method: "DELETE",
      pin,
    }),

  devices: (pin?: string) =>
    request<
      Array<{
        id: string;
        label: string;
        kind: string;
        memberId: string | null;
        createdAt: number;
        lastSeenAt: number | null;
      }>
    >("devices", "/devices", { pin }),
  createInvite: (
    body: { kind: string; label: string; memberId?: string | null },
    pin?: string,
  ) => post<{ url: string; expiresAt: number }>("invite-create", "/devices/invites", body, pin),
  updateDevice: (deviceId: string, patch: { label?: string }, pin?: string) =>
    request<{ id: string; label: string; kind: string; memberId: string | null }>(
      "device-update",
      `/devices/${deviceId}`,
      { method: "PATCH", body: JSON.stringify(patch), pin },
    ),
  revokeDevice: (deviceId: string, pin?: string) =>
    request<{ ok: true }>("device-revoke", `/devices/${deviceId}`, { method: "DELETE", pin }),

  pushConfig: () => request<{ publicKey: string | null }>("push-config", "/push/config"),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    post<{ ok: true }>("push-subscribe", "/push/subscribe", body),
};
