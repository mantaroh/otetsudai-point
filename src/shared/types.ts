/**
 * クライアントと Worker で共有する API の型。
 * ここに書かれた形だけがネットワーク越しに流れる。DB の行の形をそのまま出さない。
 */

export type MemberRole = "child" | "parent";
export type MembershipRole = "owner" | "parent" | "viewer";
export type DeviceKind = "shared" | "child" | "parent";
export type SheetStatus = "active" | "full" | "redeemed";

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  avatar: string | null;
  color: string | null;
  sortOrder: number;
}

export interface FamilySettings {
  capacity: number;
  requireApproval: boolean;
  allowSelfGrant: boolean;
  selfRevokeSec: number;
  siblingsVisible: boolean;
  stickerTheme: string;
  /** 画面の操作記録を何日ぶん残すか。0 なら記録しない */
  uiLogDays: number;
}

export interface Family {
  id: string;
  name: string;
}

export interface Chore {
  id: string;
  name: string;
  emoji: string | null;
  defaultCount: number;
  useCount: number;
  lastUsedAt: number | null;
}

export interface Sticker {
  id: string;
  grantId: string;
  position: number;
  art: string | null;
  createdAt: number;
}

export interface Sheet {
  id: string;
  memberId: string;
  seqNo: number;
  capacity: number;
  status: SheetStatus;
  /** 有効なシールの枚数 */
  filled: number;
  startedAt: number;
  filledAt: number | null;
  redeemRequestedAt: number | null;
  redeemedAt: number | null;
  stickers: Sticker[];
}

export interface Grant {
  id: string;
  memberId: string;
  choreId: string | null;
  choreLabel: string;
  choreEmoji: string | null;
  count: number;
  /** 倍にする前の枚数（子が押した回数） */
  baseCount: number;
  /** 適用した倍率。ふだんは 1 */
  multiplier: number;
  note: string | null;
  createdBy: string;
  createdByName: string;
  createdVia: "self" | "parent";
  createdAt: number;
  approvedAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface Redemption {
  id: string;
  sheetId: string;
  memberId: string;
  seqNo: number;
  rewardText: string;
  category: string | null;
  amountYen: number | null;
  approvedAt: number;
  approvedByName: string;
}

/** いま操作している主体が何をしてよいか。UI の出し分けはこれだけを見る。 */
export interface AuthInfo {
  kind: "user" | "device";
  /** 端末が特定の子に固定されている場合、その子のID */
  lockedMemberId: string | null;
  /** PIN なしで親操作ができるか(OAuth ログイン済み、または skip_pin の親端末) */
  canActAsParent: boolean;
  /** 親操作に PIN が必要か */
  needsPin: boolean;
  userDisplayName: string | null;
}

export interface BootstrapResponse {
  family: Family;
  settings: FamilySettings;
  members: Member[];
  chores: Chore[];
  /** memberId -> いま貼れる台帳 */
  sheets: Record<string, Sheet>;
  /**
   * 満了して、親のハンコを待っている台帳。
   * 繰り越しが起きると、いま貼れる台帳とは別にこちらが増える(1人で2冊持つ状態)。
   */
  pendingSheets: Sheet[];
  /**
   * 承認待ちの申請。requireApproval が有効な家庭でだけ溜まる。
   * 親はここから承認し、子は「しんせいちゅう」として自分の申請を見る。
   */
  pendingGrants: Grant[];
  auth: AuthInfo;
  bonusToday: BonusState;
}

export interface GrantRequest {
  memberId: string;
  /** 既存メニューから選んだ場合 */
  choreId?: string;
  /** 「そのほか」で入力した場合。メニューに自動追加される */
  choreName?: string;
  count: number;
  note?: string;
  /** 連打による二重送信を防ぐためのクライアント生成 UUID */
  requestId: string;
}

export interface GrantResponse {
  grant: Grant;
  /** 付与によって変化した台帳(繰り越しが起きると2冊返る) */
  sheets: Sheet[];
  /** この付与で満了した台帳があれば true */
  becameFull: boolean;
}

export interface RedeemRequest {
  rewardText: string;
  category?: string;
  amountYen?: number;
}

export interface MeResponse {
  user: { id: string; displayName: string | null; email: string | null } | null;
  families: Array<{ id: string; name: string; role: MembershipRole }>;
  currentFamilyId: string | null;
}

export interface CreateFamilyRequest {
  familyName: string;
  pin: string;
  parentName: string;
  children: Array<{ name: string; avatar?: string; color?: string }>;
  capacity?: number;
}

export interface ApiError {
  error: string;
  message: string;
}

// ── 画面の操作記録 ──────────────────────────────

/**
 * 記録するイベントの種類。
 *
 * view/leave … 画面に入った・出た(leave の value は滞在ミリ秒)
 * step       … 同じ画面の中での段階(お手伝いを選ぶ → 貼る、など)
 * action     … 意図のある操作。「使われているか」を数える
 * flow       … 目的達成までの計測値(1枚目まで何ミリ秒・何タップ)
 * friction   … つまずき。空振りタップ、連打、すぐ戻す、引き返す
 * error      … 操作が失敗した。name はサーバのエラーコード
 */
export type UiEventType = "view" | "leave" | "step" | "action" | "flow" | "friction" | "error";

export interface UiEventInput {
  /** セッション内の連番。再送しても二重に数えないための鍵 */
  seq: number;
  /** 端末の時計での発生時刻。ずれはサーバ側で補正される */
  t: number;
  screen: string;
  type: UiEventType;
  name: string;
  value?: number;
  detail?: string;
  memberId?: string;
}

export interface UiEventBatch {
  sessionId: string;
  /** 送信時点の端末の時計。サーバが時計のずれを補正するのに使う */
  now: number;
  /**
   * この画面を動かしているビルドのID。
   * ホーム画面から開いたままの端末が古いビルドで動き続けていないかを見るために持つ。
   */
  appVersion?: string;
  events: UiEventInput[];
}

export interface ScreenUsage {
  screen: string;
  views: number;
  sessions: number;
  /** 滞在時間の中央値(ミリ秒)。leave が1件も無ければ null */
  medianDwellMs: number | null;
}

export interface NamedCount {
  name: string;
  screen: string | null;
  detail: string | null;
  count: number;
}

export interface MemberUsage {
  memberId: string;
  sessions: number;
  sticks: number;
  undos: number;
  frictions: number;
  /** その子の1枚目までの中央値(ミリ秒) */
  medianFirstStickerMs: number | null;
}

export interface DailyUsage {
  /** 家庭のタイムゾーンでの YYYY-MM-DD */
  date: string;
  sessions: number;
  sticks: number;
}

/**
 * UI 改善のための集計。
 * 生のイベントは返さない。画面から見るのは、ここまで丸めたものだけでよい。
 */
export interface UiInsights {
  days: number;
  from: number;
  retentionDays: number;
  sessions: number;
  events: number;
  screens: ScreenUsage[];
  actions: NamedCount[];
  frictions: NamedCount[];
  errors: NamedCount[];
  /** 台帳を開いた → お手伝いを選んだ → シールを貼った(セッション数) */
  funnel: { opened: number; picked: number; stuck: number };
  /** 台帳を開いてから1枚目を貼るまで */
  firstSticker: {
    samples: number;
    p50Ms: number | null;
    p90Ms: number | null;
    medianTaps: number | null;
  };
  members: MemberUsage[];
  daily: DailyUsage[];
}

// ── ポイント2倍デー ────────────────────────────

export type BonusKind = "once" | "weekly" | "monthly";

export interface BonusRule {
  id: string;
  kind: BonusKind;
  /** kind='once' のとき 'YYYY-MM-DD' */
  onDate: string | null;
  /** kind='weekly' のとき 0(日)..6(土) */
  weekday: number | null;
  /** kind='monthly' のとき 1..31 */
  dayOfMonth: number | null;
  multiplier: number;
  createdAt: number;
}

/** 定期ルールの追加リクエスト */
export type BonusRuleInput =
  | { kind: "weekly"; weekday: number }
  | { kind: "monthly"; dayOfMonth: number };

/** 今日が2倍かどうか。bootstrap にも載せる */
export interface BonusState {
  active: boolean;
  multiplier: number;
  /** 2倍になっている理由。'none' なら倍率なし */
  source: "none" | "once" | "weekly" | "monthly";
  /** 家庭のローカル日付 */
  dayKey: string;
}
