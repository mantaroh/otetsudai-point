import { badRequest } from "./errors";

/**
 * 小さな手書きバリデータ。
 * 入力の種類が少ないうちは、スキーマライブラリを足すより読みやすい。
 */

export function asString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") throw badRequest(`${field} は文字列で指定してください`);
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (trimmed.length < min) throw badRequest(`${field} を入力してください`);
  if (trimmed.length > max) throw badRequest(`${field} は ${max} 文字以内で入力してください`);
  return trimmed;
}

export function asOptionalString(
  value: unknown,
  field: string,
  options: { max?: number } = {},
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return asString(value, field, { min: 1, max: options.max ?? 200 });
}

export function asInt(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num)) {
    throw badRequest(`${field} は整数で指定してください`);
  }
  if (options.min !== undefined && num < options.min) {
    throw badRequest(`${field} は ${options.min} 以上で指定してください`);
  }
  if (options.max !== undefined && num > options.max) {
    throw badRequest(`${field} は ${options.max} 以下で指定してください`);
  }
  return num;
}

export function asOptionalInt(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return asInt(value, field, options);
}

export function asOptionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} は true / false で指定してください`);
  return value;
}

/** 色は #rrggbb だけを受け付ける。表示にそのまま流し込むので、形を絞っておく。 */
export function asColor(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest(`${field} は #rrggbb の形式で指定してください`);
  }
  return value.toLowerCase();
}

/** PIN は4〜8桁の数字に限定する。文字種を絞ることで入力UIを大きなテンキーにできる。 */
export function asPin(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4,8}$/.test(value)) {
    throw badRequest("PIN は 4〜8 桁の数字で指定してください");
  }
  return value;
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest("リクエストの形式が不正です");
  }
}
