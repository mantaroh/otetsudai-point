# ポイント2倍デー と おしらせ通知 設計

親が「今日はポイント2倍」を切り替えられるようにする。
単発（今日だけ）と、定期（毎週日曜・毎月9日など）の両方を扱う。

あわせて、2倍の日に子どもへ通知を出す。通知は Web Push を使う。

前提と背景は [DESIGN.md](../../../DESIGN.md) を参照。ここではその上に載る差分だけを書く。

## 決めたこと

| 項目 | 決定 |
|---|---|
| 適用範囲 | 家族全員。子ごとの倍率は持たない |
| 倍率 | 2倍固定。列は用意するが UI からは選ばせない |
| 定期ルール | 複数登録できる（曜日と日付を同時に持てる） |
| 単発の取り消し | できる。ただし取り消し前に貼られたシールは遡及して剥がさない |
| 日付の境界 | `family_settings.timezone`（既定 `Asia/Tokyo`）のローカル日付 |
| 倍率の確定 | シールを貼った瞬間に凍結する（承認時ではない） |
| バナー | ホームと台帳の一番上に帯。「いま おてつだいする」で導線を作る |
| 通知 | Web Push。閉じていても届く。非対応端末は開いたときのバナーに落とす |
| 送信タイミング | 親が ON した瞬間 ＋ 定期日の朝 8:00（家庭のタイムゾーン） |
| 通知の許可 | 子の台帳画面のボタンから、子がタップして取る |
| Push の実装 | ライブラリを1つ追加する |

倍率を承認時ではなく申告時に決めるのは、承認あり運用で親の承認が翌日にずれたときに
「2倍のつもりで押したのに1倍だった」が起きるため。子どもに説明できない挙動は入れない。

## 前提にする制約

**iOS / iPadOS の Web Push は 16.4 以降、かつホーム画面に追加した PWA でしか動かない。**
Safari のタブで開いている状態では、通知の許可すら求められない。

このアプリの主な想定はリビングの iPad なので、ここは実運用に直接効く。
そのため、Push が使えない端末では画面のバナーに落とす前提で組む。
Android Chrome と PC は制約なしで動く。

Service Worker（`public/sw.js`）と manifest は既にあるので、土台の追加は要らない。

---

# 第1部　ポイント2倍デー

## データ

### 新テーブル `bonus_rules`

単発も定期も同じテーブルの1行として持つ。
「今日だけ2倍」は `kind='once'` の行を1つ入れることと同じ。

```sql
CREATE TABLE bonus_rules (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  kind         TEXT NOT NULL CHECK (kind IN ('once', 'weekly', 'monthly')),
  on_date      TEXT,     -- kind='once' のとき 'YYYY-MM-DD'(家庭のローカル日付)
  weekday      INTEGER,  -- kind='weekly' のとき 0(日)..6(土)
  day_of_month INTEGER,  -- kind='monthly' のとき 1..31
  multiplier   INTEGER NOT NULL DEFAULT 2 CHECK (multiplier BETWEEN 2 AND 10),
  created_by   TEXT REFERENCES members (id),
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER,
  CHECK (
    (kind = 'once'    AND on_date IS NOT NULL AND weekday IS NULL AND day_of_month IS NULL) OR
    (kind = 'weekly'  AND on_date IS NULL AND weekday BETWEEN 0 AND 6 AND day_of_month IS NULL) OR
    (kind = 'monthly' AND on_date IS NULL AND weekday IS NULL AND day_of_month BETWEEN 1 AND 31)
  )
);
CREATE INDEX bonus_rules_family ON bonus_rules (family_id, disabled_at);

-- 同じ内容のルールが二重に登録されないようにする(有効なものだけ)
CREATE UNIQUE INDEX bonus_rules_once
  ON bonus_rules (family_id, on_date)      WHERE kind = 'once'    AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_weekly
  ON bonus_rules (family_id, weekday)      WHERE kind = 'weekly'  AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_monthly
  ON bonus_rules (family_id, day_of_month) WHERE kind = 'monthly' AND disabled_at IS NULL;
```

削除ではなく `disabled_at` で無効化するのは、既存テーブルの方針（`revoked_at` / `archived_at`）に合わせるため。
重複登録を部分ユニークインデックスで弾くのも `stickers_slot` などと同じ考え方で、
アプリ側の約束ではなくスキーマ側の制約として持たせる。

### `grants` に2列追加

```sql
ALTER TABLE grants ADD COLUMN base_count INTEGER;
ALTER TABLE grants ADD COLUMN multiplier INTEGER NOT NULL DEFAULT 1;
```

`grants.count` の意味は変えない。今まで通り「実際に貼られたシールの枚数」＝倍したあとの値。
これにより `allocate` / `buildIssueStatements` / 取り消しの処理は**一切変更しなくて済む**。

`base_count` は倍する前の枚数（子が押した回数）。
既存行は NULL なので、読み出し時は `base_count ?? count` として扱う。

## 倍率の評価

DB を触らない純関数に切り出す。単体テストで曜日・日付・月末を詰められるようにするため。

`src/worker/lib/day.ts`

| 関数 | 役割 |
|---|---|
| `dayKey(at, timeZone)` | epoch ミリ秒 → `'2026-09-05'` |
| `weekdayOf(key)` | `'2026-09-05'` → 0(日)..6(土) |
| `dayOfMonthOf(key)` | `'2026-09-05'` → 5 |
| `localHour(at, timeZone)` | epoch ミリ秒 → 0..23（朝の送信判定に使う） |

`dayKey` は `Intl.DateTimeFormat('en-CA', { timeZone })` で `YYYY-MM-DD` を得る。
曜日は日付文字列を `Date.UTC` で読み直して求める。タイムゾーンを二度通さない。

`src/worker/db/bonus.ts`

```ts
export function multiplierFor(rules: BonusRule[], key: string): number
```

該当なしなら `1`。複数該当したら最大値を採る（今は全て2なので実質1通り）。

### 境界の扱い

`bonus_until`（絶対時刻）ではなく日付キーで持つ。
ローカル日付が変われば `once` ルールは自然に外れるので、期限切れを掃除する仕組みが要らない。

**毎月31日は、31日がない月はスキップする。** 月末に丸めない。
「毎月9日」のような約束を切り上げ・切り下げで動かすと、子どもとの約束としてはかえって分かりにくい。

## API

`src/worker/routes/bonus.ts`（新規、親のみ）

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/bonus` | ルール一覧 ＋ 今日の状態 |
| `POST` | `/api/bonus/today` | 今日を2倍にする（`once` を1行入れる）＋通知を送る |
| `DELETE` | `/api/bonus/today` | 今日の `once` を無効化する |
| `POST` | `/api/bonus/rules` | 定期ルール追加 `{kind:'weekly', weekday:0}` / `{kind:'monthly', dayOfMonth:9}` |
| `DELETE` | `/api/bonus/rules/:id` | 定期ルール削除 |

`GET /api/bootstrap` の返りに `bonusToday: { active: boolean, multiplier: number }` を足す。
子端末にも返す（バナーに使う）。

### 定期で2倍の日を、その日だけ止めることはできない

`DELETE /api/bonus/today` が消すのは `once` の行だけ。
毎週日曜の設定で2倍になっている日曜は、この操作では戻せない。

除外ルール（`skip`）を足せば実現できるが、今は入れない。
必要になったら `kind='skip'` を追加して `multiplierFor` で優先させる形で足せる。
親設定の画面では、定期ルールで2倍になっている日は
「毎週日曜の設定で2倍です」と理由を出し、トグルを押せない状態にする。

### 取り消しは遡及しない

`DELETE /api/bonus/today` の前に貼られたシールはそのまま残る。
既に子どもの台帳に貼られたものを後から剥がすのは、この仕組みの目的ではない。
個別に消したいときは既存の取り消し（`revokeGrant`）を使う。

**通知も取り消さない。** 送ってしまった通知は消せないので、
ON を押した直後に取り消しても「2倍だよ」の通知だけが残る。ここは運用で受け入れる。

## 付与の流れ

`src/worker/routes/ledger.ts` の `POST /grants`：

```ts
const baseCount  = asInt(body.count, "枚数", { min: 1, max: 50 });
const multiplier = await resolveMultiplier(c.env.DB, auth.familyId, Date.now());
const count      = baseCount * multiplier;
```

`count` の上限は倍後で最大100枚になる。台帳（既定30マス）をまたぐのは
`buildIssueStatements` が既に対応しているので、新しい処理は要らない。

`CreateGrantInput` に `baseCount` と `multiplier` を足し、`count` は倍後の値を渡す。
`requestId` による二重送信の握りつぶしは既存のまま。倍率も一緒に凍結される。

---

# 第2部　バナー

子どもが気づいて、そのままお手伝いに進めることを狙う。
気づかせるだけで終わらせない。

`src/client/components/BonusBanner.tsx`（新規）

| 置き場所 | 挙動 |
|---|---|
| ホーム（`Home.tsx`） | 一番上に全幅の帯。「いま おてつだいする」で自分の台帳へ |
| 台帳（`Ledger.tsx`） | 一番上に全幅の帯。「いま おてつだいする」でお手伝い選択までスクロール |

帯の中身：

```
きょうは ポイント2ばい デー！
おてつだいすると シールが 2まい もらえるよ

[ いま おてつだいする ]   [ おしらせを うけとる ]
```

「おしらせを うけとる」は、通知が未許可で、かつその端末が Push に対応しているときだけ出す。
許可済み、または非対応の端末では出さない。

**親の履歴** では `multiplier > 1` の行に `×2` バッジを出す。承認待ちの一覧も同じ。

文言は既存の子ども向け画面に合わせて、ひらがな中心にする。
バナーの表示・タップは既存の `track()` で `bonus-banner` として記録し、
「見えているのに押されていない」が後から分かるようにする。

---

# 第3部　おしらせ通知

## データ

`migrations/0005_push.sql`

```sql
CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  device_id    TEXT REFERENCES devices (id),
  member_id    TEXT REFERENCES members (id),
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_sent_at INTEGER,
  failed_count INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX push_subscriptions_endpoint
  ON push_subscriptions (endpoint) WHERE revoked_at IS NULL;
CREATE INDEX push_subscriptions_family
  ON push_subscriptions (family_id, revoked_at);

-- 同じ家庭・同じ日・同じ種類の通知は1回しか送らない
CREATE TABLE push_sends (
  family_id TEXT NOT NULL REFERENCES families (id),
  day_key   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (family_id, day_key, kind)
);
```

### 二重送信は主キーで止める

親が夜に ON を押した日は即時送信され、その日の朝の Cron は既に過ぎている。
逆に定期日は朝に送られ、その日に親が ON を押しても二度目は送りたくない。

送信前に `push_sends` へ `INSERT` し、主キー衝突したら送らない。
アプリ側の条件分岐ではなく、DB の制約で止める。
`stickers_slot` や `grants_request_id` と同じ考え方。

### 失効した購読の掃除

送信結果が `404` / `410` なら購読が失効しているので `revoked_at` を立てる。
それ以外の失敗は `failed_count` を進め、5回続いたら同じく無効化する。

## 鍵と設定

VAPID 鍵を Cloudflare のシークレットに置く。

| 名前 | 中身 |
|---|---|
| `VAPID_PUBLIC_KEY` | 公開鍵。クライアントにも渡す |
| `VAPID_PRIVATE_KEY` | 秘密鍵 |
| `VAPID_SUBJECT` | `mailto:` から始まる連絡先 |

生成用に `scripts/make-vapid.mjs` を足す（`npm run vapid`）。
既存の `scripts/make-icons.mjs` と同じ置き方にする。

公開鍵は `GET /api/push/config` で返す。クライアントにハードコードしない。

## Cron

`wrangler.jsonc` に追加する。

```jsonc
"triggers": { "crons": ["0 * * * *"] }
```

毎時0分に起動し、`family_settings.timezone` でローカル時刻が 8 時の家庭だけを対象にする。
Cloudflare の cron は UTC 固定なので、時差の吸収はアプリ側で行う。

`src/worker/index.ts` に `scheduled` ハンドラを足す。
処理は `src/worker/lib/notify.ts` に切り出し、Cron からもテストからも同じ関数を呼べるようにする。

## 送信の実装

Workers 対応の Web Push ライブラリを1つ追加する（`@block65/webcrypto-web-push` を想定）。

VAPID の ES256 署名と `aes128gcm` の暗号化は自前でも書けるが、
暗号処理は「動いているように見えて実は届いていない」の切り分けが難しい。
実行時依存が5つしかないリポジトリに1つ足すコストより、この見えにくさのほうが高くつくと判断した。

## Service Worker

`public/sw.js` に `push` と `notificationclick` を足し、`VERSION` を `v2` に上げる。

```js
self.addEventListener("push", (event) => { /* showNotification */ });
self.addEventListener("notificationclick", (event) => { /* clients.openWindow("/") */ });
```

タップしたら既に開いているウィンドウを探して前面に出す。無ければ `/` を開く。

## 文言

| 項目 | 内容 |
|---|---|
| タイトル | `きょうは ポイント2ばい デー！` |
| 本文 | `おてつだいすると シールが 2まい もらえるよ。いっぱい ためよう！` |
| アイコン | `/icons/icon-192.png` |
| タグ | `bonus-<day_key>`（同じ日の通知が重ならないように） |

## API

`src/worker/routes/push.ts`（新規）

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/push/config` | VAPID 公開鍵を返す |
| `POST` | `/api/push/subscribe` | 購読を登録する |
| `DELETE` | `/api/push/subscribe` | 購読を解除する（`endpoint` を指定） |

購読の登録は子端末からも行うので、親限定にはしない。
登録できるのは自分の端末の購読だけで、`device_id` はセッションから決める。クライアントの申告は使わない。

## クライアント

`src/client/lib/push.ts`（新規）

| 関数 | 役割 |
|---|---|
| `canUsePush()` | `PushManager` の有無と、iOS ならホーム画面起動かを見る |
| `subscribe()` | 許可を求め、`pushManager.subscribe()` し、サーバに登録する |
| `unsubscribe()` | 解除する |

`canUsePush()` が `false` の端末には「おしらせを うけとる」を出さない。
押したのに何も起きない、が一番わかりにくいため。

---

## 触るファイル

| ファイル | 変更 |
|---|---|
| `migrations/0004_bonus.sql` | 新規 |
| `migrations/0005_push.sql` | 新規 |
| `src/worker/lib/day.ts` | 新規 |
| `src/worker/lib/notify.ts` | 新規（送信の本体。Cron と API の両方から呼ぶ） |
| `src/worker/db/bonus.ts` | 新規 |
| `src/worker/db/push.ts` | 新規 |
| `src/worker/routes/bonus.ts` | 新規 |
| `src/worker/routes/push.ts` | 新規 |
| `src/worker/index.ts` | ルート登録、`scheduled` ハンドラ |
| `src/worker/db/ledger.ts` | `CreateGrantInput` と `GRANT_COLUMNS` に `base_count` / `multiplier` |
| `src/worker/routes/ledger.ts` | 付与時に倍率を解決、bootstrap に `bonusToday` |
| `src/shared/types.ts` | `BonusRule` / `BonusState` / `Grant` の拡張 |
| `src/client/lib/push.ts` | 新規 |
| `src/client/components/BonusBanner.tsx` | 新規 |
| `src/client/api.ts` | 呼び出し追加 |
| `src/client/screens/ParentSettings.tsx` | `BonusSection` |
| `src/client/screens/Home.tsx` | バナー |
| `src/client/screens/Ledger.tsx` | バナー |
| `src/client/screens/Parent.tsx` | 履歴と承認待ちのバッジ |
| `public/sw.js` | `push` / `notificationclick`、`VERSION` を v2 へ |
| `wrangler.jsonc` | `triggers.crons` |
| `package.json` | Web Push ライブラリ、`npm run vapid` |
| `scripts/make-vapid.mjs` | 新規 |
| `README.md` / `DEPLOY.md` | VAPID 鍵の作り方と設定手順 |

## テスト

| 層 | 見るもの |
|---|---|
| 単体 | `dayKey` のタイムゾーン境界（JST 23:59 と 00:00）、`localHour`、`multiplierFor` の曜日・毎月9日・31日がない月・無効化済みルール・複数該当 |
| API結合 | 2倍ONで3回押す → シール6枚・`multiplier=2` が記録される。取り消し後は1倍。定期ルールで該当する日も2倍。購読の登録と解除。ON で `push_sends` に行ができ、同じ日の2回目は送られない |
| 画面 | 親設定のトグルと定期ルール追加・削除、バナーの出し分け、「いま おてつだいする」の遷移、Push 非対応端末で「おしらせを うけとる」が出ないこと、履歴バッジ |
| E2E | バナーの表示とお手伝いへの導線まで。実際の Push 配信は対象外 |

台帳をまたぐケース（残り2マスで倍後6枚）は API 結合に含める。

Push の送信そのものはライブラリに任せるので、テストではライブラリの呼び出しを差し替え、
「誰に・何回・どの文言で呼ばれたか」と `push_sends` の状態だけを見る。

## 動作確認

実装後、以下を実機で確認してスクリーンショットを残す。

1. 親設定で今日を2倍にする → Android Chrome に通知が届く
2. 通知をタップ → アプリが開く
3. 台帳にバナーが出る →「いま おてつだいする」でお手伝い選択に進む
4. 3回押す → シールが6枚貼られる
5. iPad（ホーム画面追加）で通知が届く。タブで開いた場合は「おしらせを うけとる」が出ない

## ターン数

| | ターン数 |
|---|---|
| 予定 | 設計 5 / 実装 13 |
| 実際 | （完了時に記入） |

実装計画は [../plans/2026-09-05-bonus-multiplier.md](../plans/2026-09-05-bonus-multiplier.md)。
