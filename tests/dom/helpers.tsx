import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type {
  BootstrapResponse,
  Chore,
  Grant,
  Member,
  Sheet,
  Sticker,
} from "../../src/shared/types";
import { PinProvider } from "../../src/client/pin";

/**
 * 画面テスト用の足場。実プロバイダをそのまま使い、API だけをモックする。
 * 返り値の queryClient を使うと、裏での再取得を意図的に起こせる。
 */
export function renderScreen(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchInterval: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <PinProvider>{ui}</PinProvider>
      </QueryClientProvider>,
    ),
  };
}

// ── フィクスチャ ──────────────────────────────

export const HANA: Member = {
  id: "mem_hana",
  name: "はな",
  role: "child",
  avatar: "🐰",
  color: "#ff8fab",
  sortOrder: 1,
};

export const TARO: Member = {
  id: "mem_taro",
  name: "たろう",
  role: "child",
  avatar: "🦊",
  color: "#5bc0eb",
  sortOrder: 2,
};

export const PARENT: Member = {
  id: "mem_parent",
  name: "おとうさん",
  role: "parent",
  avatar: "👤",
  color: "#7c6f5a",
  sortOrder: 0,
};

export const CHORE_BATH: Chore = {
  id: "cho_bath",
  name: "おふろそうじ",
  emoji: "🛁",
  defaultCount: 1,
  useCount: 10,
  lastUsedAt: null,
  sortOrder: 0,
};

export const CHORE_WALK: Chore = {
  id: "cho_walk",
  name: "いぬのさんぽ",
  emoji: "🐕",
  defaultCount: 3,
  useCount: 4,
  lastUsedAt: null,
  sortOrder: 1,
};

export function makeStickers(count: number, art: string | null = "🛁"): Sticker[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `stk_${index + 1}`,
    grantId: `grt_${index + 1}`,
    position: index + 1,
    art,
    // 画面を開くより前に貼られたシール、という扱いにする
    createdAt: 1,
  }));
}

export function makeSheet(overrides: Partial<Sheet> = {}): Sheet {
  const stickers = overrides.stickers ?? makeStickers(overrides.filled ?? 3);
  return {
    id: "sht_1",
    memberId: HANA.id,
    seqNo: 1,
    capacity: 5,
    status: "active",
    filled: stickers.length,
    startedAt: 1,
    filledAt: null,
    redeemRequestedAt: null,
    redeemedAt: null,
    ...overrides,
    stickers,
  };
}

export function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "grt_1",
    memberId: HANA.id,
    choreId: CHORE_BATH.id,
    choreLabel: CHORE_BATH.name,
    choreEmoji: CHORE_BATH.emoji,
    count: 1,
    baseCount: 1,
    multiplier: 1,
    note: null,
    createdBy: HANA.id,
    createdByName: HANA.name,
    createdVia: "self",
    createdAt: Date.UTC(2026, 7, 1, 9, 0),
    approvedAt: Date.UTC(2026, 7, 1, 9, 0),
    revokedAt: null,
    revokeReason: null,
    ...overrides,
  };
}

/** 承認待ちの申請(まだシールになっていない) */
export function makeRequest(overrides: Partial<Grant> = {}): Grant {
  return makeGrant({ approvedAt: null, ...overrides });
}

export function makeBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  const sheets = overrides.sheets ?? { [HANA.id]: makeSheet() };
  // 既定では、満了している台帳がそのまま「ハンコ待ち」になる。
  // 繰り越しのケースを試したいときは pendingSheets を明示的に渡す。
  const pendingSheets =
    overrides.pendingSheets ?? Object.values(sheets).filter((sheet) => sheet.status === "full");
  return {
    family: { id: "fam_1", name: "やまだ家" },
    settings: {
      capacity: 5,
      requireApproval: false,
      allowSelfGrant: true,
      selfRevokeSec: 300,
      siblingsVisible: true,
      stickerTheme: "default",
      uiLogDays: 90,
    },
    members: [PARENT, HANA, TARO],
    chores: [CHORE_BATH, CHORE_WALK],
    auth: {
      kind: "device",
      lockedMemberId: null,
      canActAsParent: false,
      needsPin: true,
      userDisplayName: null,
    },
    pendingGrants: [],
    bonusToday: { active: false, multiplier: 1, source: "none", dayKey: "2026-09-05" },
    ...overrides,
    sheets,
    pendingSheets,
  };
}
