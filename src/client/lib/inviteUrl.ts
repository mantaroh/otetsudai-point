/**
 * LINE に招待リンクを送るときは、外部ブラウザで開かせる必要がある。
 *
 * LINE でリンクをタップすると、既定ではアプリ内ブラウザ(LIFF ブラウザ)で開く。
 * そこで端末を登録しても、Cookie はアプリ内ブラウザの中にしか残らない。
 * あとで Safari や Chrome からアプリを開くとログインしていない状態になり、
 * せっかくの招待が無駄になる。
 *
 * URL に openExternalBrowser=1 を付けておくと、LINE が既定のブラウザで開いてくれる。
 * LINE 以外(メール、AirDrop、QR コードの読み取り)では、ただの見慣れない
 * クエリパラメータとして無視されるだけで、害はない。
 */
export const EXTERNAL_BROWSER_PARAM = "openExternalBrowser";

export function withExternalBrowser(url: string, enabled: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 壊れた URL でも画面を落とさない。そのまま返す
    return url;
  }

  if (enabled) parsed.searchParams.set(EXTERNAL_BROWSER_PARAM, "1");
  else parsed.searchParams.delete(EXTERNAL_BROWSER_PARAM);

  return parsed.toString();
}
