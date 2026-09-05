import type { BootstrapResponse } from "../../src/shared/types";

export const API_PORT = Number(process.env.API_TEST_PORT ?? 5174);
export const BASE_URL = `http://localhost:${API_PORT}`;

/**
 * 1つの端末(= 1つの Cookie 入れ)を表す。
 *
 * 「親のスマホ」「リビングのタブレット」「たろうのスマホ」をそれぞれ別インスタンスにして、
 * 見えるもの・できることが本当に分かれているかを確かめる。
 */
export class Client {
  #cookies = new Map<string, string>();

  async request(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.#cookies.size > 0) headers.set("Cookie", this.cookieHeader());

    const response = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "" || /Max-Age=0/i.test(cookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }

    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 300) };
      }
    }
    return { status: response.status, body, headers: response.headers };
  }

  get = (path: string) => this.request(path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) =>
    this.request(path, { method: "POST", body, headers });
  patch = (path: string, body?: unknown, headers?: Record<string, string>) =>
    this.request(path, { method: "PATCH", body, headers });
  del = (path: string, headers?: Record<string, string>) =>
    this.request(path, { method: "DELETE", headers });

  cookieHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  setCookie(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  getCookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  clearCookies(): void {
    this.#cookies.clear();
  }
}

export const uuid = () => crypto.randomUUID();

/** 招待リンクからトークンを取り出す */
export function inviteToken(inviteUrl: string): string {
  return new URL(inviteUrl).pathname.replace(/^\/invite\//, "");
}

/**
 * 招待を引き換えるエンドポイント。
 *
 * リンクを「開く」(GET /invite/:token)では何も起こらない。
 * LINE のリンクプレビューのような、開くだけの相手に使い切られないようにするため、
 * 引き換えは必ずこの POST を通す。
 */
export function claimPath(inviteUrl: string): string {
  return `/api/invites/${inviteToken(inviteUrl)}/claim`;
}

let subjectCounter = 0;

/** テストごとに別のユーザーで入る。家庭がまだ無い状態から始めるため。 */
export async function signInFresh(client: Client): Promise<void> {
  subjectCounter += 1;
  const subject = `test-${Date.now().toString(36)}-${subjectCounter}`;
  const result = await client.post("/auth/dev", { subject });
  if (result.status !== 200) throw new Error(`サインインに失敗: ${JSON.stringify(result.body)}`);
}

export interface Household {
  client: Client;
  boot: BootstrapResponse;
  familyId: string;
  children: BootstrapResponse["members"];
  choreId: string;
}

/** 家庭を1つ作り、ブートストラップまで済ませた状態を返す */
export async function createHousehold(options: {
  familyName?: string;
  childNames?: string[];
  capacity?: number;
  pin?: string;
} = {}): Promise<Household> {
  const client = new Client();
  await signInFresh(client);

  const created = await client.post("/api/families", {
    familyName: options.familyName ?? "テスト家",
    parentName: "おとうさん",
    pin: options.pin ?? "1234",
    capacity: options.capacity ?? 5,
    children: (options.childNames ?? ["はな", "たろう"]).map((name) => ({ name })),
  });
  if (created.status !== 201) {
    throw new Error(`家庭の作成に失敗: ${JSON.stringify(created.body)}`);
  }

  const boot = (await client.get("/api/bootstrap")).body as BootstrapResponse;
  return {
    client,
    boot,
    familyId: boot.family.id,
    children: boot.members.filter((member) => member.role === "child"),
    choreId: boot.chores[0]!.id,
  };
}

/** シールを n 枚貼る */
export function stick(
  client: Client,
  memberId: string,
  choreId: string,
  count = 1,
): Promise<{ status: number; body: any }> {
  return client.post("/api/grants", { memberId, choreId, count, requestId: uuid() });
}

export async function currentSheet(client: Client, memberId: string) {
  const boot = (await client.get("/api/bootstrap")).body as BootstrapResponse;
  return boot.sheets[memberId]!;
}
