import { expect, type Page } from "@playwright/test";

/**
 * E2E 用の下ごしらえ。
 *
 * 「画面がちゃんと動くか」を見たいので、前提づくり(家庭の作成やシールの水増し)は
 * API で済ませ、確かめたい操作だけを画面から行う。
 */

/** テストごとに別のユーザーで入る。家庭がまだ無い状態から始めるため。 */
export async function signInFresh(page: Page): Promise<void> {
  const response = await page.request.post("/auth/dev", {
    data: { subject: `e2e-${crypto.randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
}

export interface Household {
  familyId: string;
  children: Array<{ id: string; name: string }>;
  choreId: string;
  capacity: number;
}

export async function createHouseholdViaApi(
  page: Page,
  options: { capacity?: number; childNames?: string[]; pin?: string } = {},
): Promise<Household> {
  await signInFresh(page);

  const capacity = options.capacity ?? 5;
  const created = await page.request.post("/api/families", {
    data: {
      familyName: "やまだ家",
      parentName: "おとうさん",
      pin: options.pin ?? "4821",
      capacity,
      children: (options.childNames ?? ["はな", "たろう"]).map((name) => ({ name })),
    },
  });
  expect(created.status()).toBe(201);

  const boot = await (await page.request.get("/api/bootstrap")).json();
  return {
    familyId: boot.family.id,
    children: boot.members
      .filter((member: any) => member.role === "child")
      .map((member: any) => ({ id: member.id, name: member.name })),
    choreId: boot.chores[0].id,
    capacity,
  };
}

/** シールを n 枚、API で貼っておく */
export async function stickViaApi(
  page: Page,
  memberId: string,
  choreId: string,
  count: number,
): Promise<void> {
  const response = await page.request.post("/api/grants", {
    data: { memberId, choreId, count, requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
}

/** 招待リンクを発行して、その URL を返す */
export async function createInvite(
  page: Page,
  input: { kind: "shared" | "child" | "parent"; label: string; memberId?: string },
): Promise<string> {
  const response = await page.request.post("/api/devices/invites", { data: input });
  expect(response.status()).toBe(201);
  const body = await response.json();
  // 招待 URL は APP_ORIGIN 基準で作られるので、テスト用のポートに読み替える
  return new URL(body.url).pathname;
}

/**
 * 招待リンクを開いて、確認画面から実際に登録する。
 *
 * 開いただけでは登録されない(リンクプレビューに使い切られないため)。
 * ボタンを押して初めて端末が登録される。
 */
export async function claimInviteInBrowser(page: Page, invitePath: string): Promise<void> {
  await page.goto(invitePath);
  await expect(page.getByRole("heading", { name: "この端末を登録しますか?" })).toBeVisible();
  await page.getByRole("button", { name: "この端末を登録する" }).click();
}

/**
 * ブラウザのコンソールエラーとページ例外を集める。
 *
 * 「操作はできたが裏で例外が出ている」「真っ白になっている」を見逃さないための保険。
 */
/**
 * 画面遷移で中断された通信は、エラーとして数えない。
 *
 * 台帳は裏で定期的に取り直しているので、その最中にページを移ると
 * WebKit が取得を打ち切り、"due to access control checks" という文言で
 * ページエラーとして報告する。同一オリジンしか叩いていないアプリなので、
 * この文言が出るのは打ち切りのときだけ。
 */
function isNavigationAbort(message: string): boolean {
  return /due to access control checks|Load failed|NetworkError|The operation was aborted/i.test(
    message,
  );
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // 未ログインの画面では bootstrap が 401 を返すのが正常。
    // ブラウザはそれもコンソールエラーとして出すので、ここだけは除く。
    if (/status of 401/.test(message.text())) return;
    if (isNavigationAbort(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    if (isNavigationAbort(error.message)) return;
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}
