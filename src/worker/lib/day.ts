/**
 * 家庭のタイムゾーンでの「日付」を扱う。
 *
 * 2倍デーの判定は絶対時刻ではなく日付で行う。
 * ローカル日付が変われば「今日だけ2倍」のルールは自然に外れるので、
 * 期限切れを掃除する仕組みが要らない。
 */

/** epoch ミリ秒 → 家庭のローカル日付 'YYYY-MM-DD' */
export function dayKey(at: number, timeZone: string): string {
  // en-CA は YYYY-MM-DD の順で返す。自前で組み立てるより取り違えが少ない。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** 'YYYY-MM-DD' → 曜日 0(日)..6(土) */
export function weekdayOf(key: string): number {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  // 日付文字列は既にローカル日付なので、ここでタイムゾーンを二度通さない
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 'YYYY-MM-DD' → 日 1..31 */
export function dayOfMonthOf(key: string): number {
  return Number(key.slice(8, 10));
}

/**
 * epoch ミリ秒 → 家庭のローカル時 0..23。
 *
 * hourCycle に h23 を明示する。hour12:false だけだと、環境によって
 * 深夜0時が "24" になることがある。
 */
export function localHour(at: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at)),
  );
}
