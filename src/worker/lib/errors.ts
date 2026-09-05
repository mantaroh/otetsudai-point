import { HTTPException } from "hono/http-exception";

/**
 * エラーは必ずこれらを通す。
 *
 * 特に notFound は「存在しない」と「他の家庭のもの」を区別せずに 404 を返すための入口。
 * 他家庭のリソースを指定したときに 403 を返すと、IDの存在有無が漏れる。
 */

function fail(status: 400 | 401 | 403 | 404 | 409 | 429 | 500, error: string, message: string) {
  return new HTTPException(status, {
    res: Response.json({ error, message }, { status }),
  });
}

export const badRequest = (message: string) => fail(400, "bad_request", message);
export const unauthorized = (message = "ログインが必要です") => fail(401, "unauthorized", message);
export const forbidden = (message = "この操作は許可されていません") => fail(403, "forbidden", message);
export const notFound = (message = "見つかりませんでした") => fail(404, "not_found", message);
export const conflict = (message: string) => fail(409, "conflict", message);
export const tooManyRequests = (message: string) => fail(429, "too_many_requests", message);
export const serverError = (message = "サーバでエラーが発生しました") =>
  fail(500, "server_error", message);

/** 親操作なのに PIN が未提示 / 誤りだったとき。クライアントは PIN 入力を出す */
export const pinRequired = (message = "親の PIN が必要です") => fail(401, "pin_required", message);
