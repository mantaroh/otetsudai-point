import type { Context } from "hono";
import type { DeviceKind, MembershipRole } from "../shared/types";

export interface AppEnv {
  DB: D1Database;
  /**
   * "development" のときだけ、開発用サインインが有効になる。
   * 本番では設定しない(未設定 = 本番扱い、という向きにしてある)。
   */
  ENVIRONMENT?: string;
  /** 公開 URL。未設定ならリクエストの origin を使う */
  APP_ORIGIN?: string;
  /** Cookie 署名鍵。ローカルは .dev.vars、本番は wrangler secret */
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Web Push の VAPID 鍵。未設定なら通知は送らない */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/**
 * 認証ミドルウェアが確定させる、この1リクエストの実効権限。
 *
 * **ハンドラは familyId をここからしか取ってはいけない。**
 * URL やリクエストボディに含まれる家庭IDは一切信用しない。
 */
export interface AuthContext {
  familyId: string;
  kind: "user" | "device";
  userId: string | null;
  membershipRole: MembershipRole | null;
  /** 親操作を記録するときの実行者。membership に紐づく member、または家庭の代表の親 */
  parentMemberId: string | null;
  device: { id: string; kind: DeviceKind; memberId: string | null } | null;
  /** 端末が特定の子に固定されている場合、その子以外は操作できない */
  lockedMemberId: string | null;
  /** PIN なしで親操作ができるか */
  canActAsParent: boolean;
}

export type Variables = {
  auth: AuthContext;
};

export type AppBindings = { Bindings: AppEnv; Variables: Variables };
export type AppContext = Context<AppBindings>;
