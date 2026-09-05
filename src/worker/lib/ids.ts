/**
 * ID はアプリ側で採番する。
 * D1 にはインタラクティブトランザクションがないため、複数テーブルへの書き込みを
 * db.batch() 一発にまとめる必要がある。そのために「INSERT する前に ID が分かっている」
 * ことが前提になる。
 */

type Prefix =
  | "usr"
  | "fam"
  | "mem"
  | "dev"
  | "inv"
  | "cho"
  | "sht"
  | "grt"
  | "stk"
  | "rdm"
  | "bns"
  | "psb";

export function newId(prefix: Prefix): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
