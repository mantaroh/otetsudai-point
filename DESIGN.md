# おてつだいポイント — システム設計

紙のシール台帳で運用している「お手伝いポイント」制度をアプリ化する。

まずは自分の家で使うが、**将来的に他の家庭でも使えるようにする**ことを前提に設計する。後からマルチテナント化するのは認証とデータ分離の作り直しになるため、その2点だけは最初から他家庭を想定した形にしておく。それ以外は自分の家の運用に最適化してよい。

## 0. 設計の原則

1. **運用を変えない。** 紙でうまく回っているルール(自己申告・30枚で交換・親のハンコで回収)をそのまま写す。アプリ都合でルールを増やさない。
2. **子供の操作は最短距離。** ログインさせない。台帳を開いて、お手伝いを選んで、シールを貼る。ここに承認待ちや入力フォームを挟まない。
3. **消さずに残す。** 取り消しは物理削除ではなく無効化。紙では消えてしまう履歴が残ることがアプリ化の最大の価値。
4. **家族の外には一切出さない。** インターネット公開するが、招待された端末以外は何も見えない。
5. **家庭ごとの違いはデータで吸収する。** 「30枚で交換」「承認なし」はうちのルールであって、アプリの仕様ではない。家庭ごとの設定として持つ。コードに定数として埋めない。

## 1. 現行運用のモデル化

| 紙の運用 | アプリ上の表現 |
|---|---|
| 子ごとのシール台帳(30マス) | `sheets` — 子1人につき1枚が `active` |
| シールを1枚貼る | `stickers` — 台帳のマスを1つ埋める |
| 「食器洗いをやった」という1回のお手伝い | `grants` — お手伝い1回の記録。シール n 枚を発行する |
| 親が貼ってあげる | `grants.created_by` が親 |
| 30枚たまる | `sheets.status = 'full'`(こうかんまち) |
| 親に渡す → ハンコ → 好きなものと交換 | `redemptions` — 親のPINで承認、交換内容を記録 |
| 台帳を回収する | `sheets.status = 'redeemed'` → 「本棚」にアーカイブ |
| 新しい台帳をもらう | 次の `sheets` を自動発行 |

### 紙になくてアプリで増えるもの

- **本棚**: 交換済みの台帳が「何と交換したか」付きで並ぶ。回収されて消えていた履歴が資産になる。
- **お手伝いメニュー**: 何をしたかの記録。集計して「今月いちばんやったお手伝い」が見える。
- **取り消し履歴**: 誤操作や過剰申告を親が後から直せて、しかも記録が残る。

## 2. 主要な仕様判断

### 2.1 承認は挟まない(信頼ベース)— ただし家庭ごとの設定にする

**うちの運用**: 子がシールボタンを押した瞬間に貼られる。紙と同じ。親は履歴で見えるので、おかしければ後から取り消す。

理由: 承認待ちにすると親が不在のとき台帳が進まず、紙より体験が悪くなる。制度の根幹は自己申告への信頼なので、そこはアプリで変えない。

**他家庭を考えると**、ここは間違いなく分かれるポイント(「勝手に貼られては困る」家庭は多いはず)。なので `family_settings.require_approval` として持つ。データモデル上は `grants.approved_at` を必ず持たせ、

- `require_approval = 0`(うち): 作成と同時に `approved_at` をセットし、シールを即発行する
- `require_approval = 1`: `approved_at` が NULL のあいだは「しんせいちゅう」として台帳の外に置き、親が承認した時点でシールを発行する

とする。UIの分岐は増えるが、**後からこのカラムを足すと既存の grants の解釈を変えることになる**ので、使わなくても最初から入れておく。

### 2.2 1回のお手伝いで複数枚貼れる

お手伝いを1つ選ぶと大きなシールボタンが出て、**タップするたびに1枚ずつ貼られる**。まとめて確定するボタンは置かない。押した回数だけ貼られる、という物理的な感覚をそのまま残す。

- お手伝いごとに「めやす枚数」(`chores.default_count`)を持たせ、選んだ時点でその枚数まで一気に貼るショートカットも用意する。
- 押しすぎたら「1枚もどす」がその場で使える(直前の付与のみ、子でも取り消し可・時間制限つき)。それより前の取り消しは親のPIN。

### 2.3 お手伝いメニューは自己増殖する家族共通マスター

- 一覧から選ぶ。なければ「そのほか」から入力する。
- **入力されたものは自動的にメニューに追加され、以後は兄弟どちらの選択肢にも出る。**
- 並び順は親が決める(親設定の ↑ ↓)。新しく足したものは一番上に来る。使われなくなったものは親がアーカイブできる(履歴からは消えない)。
  - 当初は直近の使用頻度順にしていたが、よく押すものほど上に上がっていくので、子どもから見るとボタンの位置が日によって変わっていた。毎回同じ位置に同じボタンがあるほうが使い慣れるので、親が決めた順に固定した(2026-09、`migrations/0006_chore_order.sql`)。
- 表記ゆれ(前後空白・全半角)は正規化して既存メニューにマージする。

### 2.4 台帳をまたぐ付与

残り2マスのときに3枚貼ったら、2枚で台帳が満了し、**3枚目は自動発行された次の台帳の1マス目に乗る**。紙だと起きないが、複数枚付与を許す以上必ず起きるので仕様として決めておく。

### 2.5 取り消しはマスに穴が開く

シールを取り消すと台帳にそのマスの穴が開き、**次に貼られたシールがその穴を埋める**。台帳は「有効なシール30枚」で満了とする。取り消されたシールの行は履歴として残る。

### 2.6 交換フロー

1. 有効シールが30枚 → 台帳が `full` になり「こうかんできる!」の演出。
2. 子が「こうかんしたい」を押す → 親側に「こうかんまち」が立つ。
3. 親がPINを入れて、交換内容(Roblox / Minecraft / まんが / そのほか + 自由メモ)を記録。
4. 台帳にハンコが押される演出 → `redeemed` になって本棚へ → 新しい台帳が発行される。

金額は任意入力(空でよい)。用途を縛らない現行運用に合わせ、カテゴリは必須にしない。

### 2.7 兄弟の台帳は見えるが、貼れない

紙の台帳もリビングにあって互いに見えている。閲覧はできる、シールを貼れるのは自分のだけ、という非対称にする。

## 3. 認証・アクセス制御

インターネットに公開するが、家族以外には何も見せない。同時に、子供にID/パスワードを持たせたくない。他家庭に開くなら、家庭を新規に作れる導線も要る。

この2つを両立させるため、**認証を2階建てにする**。

### 3.1 親アカウント(OAuth)

- Google / Apple でサインイン(`@hono/oauth-providers` + 署名付きセッション Cookie)。パスワードは持たない。
- サインインした `users` が家庭を新規作成し、その家庭の owner になる。他家庭への展開はこの導線がそのまま入口になる。
- 1人のユーザーが複数の家庭に属せる形にしておく(父・母の2アカウント、離れて暮らす親、祖父母など)。`memberships` で users と families を多対多にする。あとから多対多にするのは移行が面倒なので最初から。
- 用途: 外出先からの操作、家庭の管理(メニュー編集・端末管理・設定)、交換のハンコ。

> **自分の家だけならログイン不要で作れるが、これは Phase 1 に入れる。** 家庭の所有者が誰か決まっていないと、後から他家庭に開くときに既存データの持ち主を決められない。実装は Google 1プロバイダなら小さい。

### 3.2 端末登録(共有タブレット・子供用)

子供にはアカウントを持たせない。

1. 親が管理画面で **招待リンク**(短命・使い捨てトークン)を発行する。
2. その端末でリンクを開くと、**確認画面が出るだけで、まだ何も起こらない。**
3. 「この端末を登録する」を押した時点(POST)で、端末に**家族トークンを HttpOnly / Secure / SameSite=Lax な長期 Cookie(1年)**として保存する。同時に端末を `devices` に登録する。
4. 以後その端末はログイン不要。Cookie がない/失効したリクエストは全て 401。
5. 端末を紛失したら親が `devices` から失効させる。

> **リンクを開いた(GET)だけで登録してはいけない。**
> LINE に招待リンクを送ったところ、リンクプレビューの取得で使い切られて
> 「使用ずみです」になった。リンクを開くのは本人とは限らない
> (プレビュー取得、メールのセキュリティスキャン、ブラウザの先読み)。
> 副作用のある操作は必ず POST に置く。

| 種別 | 用途 | できること |
|---|---|---|
| `shared` | リビングのタブレット | 子の選択、シール付与、閲覧、交換申請 |
| `child` | 子の個人スマホ | 上記を自分の分だけ |
| `parent` | 親のスマホ(OAuth の代わりに端末登録で使う場合) | 上記 + 親操作(PIN省略を設定で許可可) |

**親操作は、OAuth セッションがない端末では常にPIN**。対象は、シール取り消し、交換のハンコ、メニュー編集、端末管理、PIN変更。PIN は PBKDF2/scrypt(Workers の WebCrypto で扱えるもの)でハッシュ化し、家族単位で連続失敗のレート制限をかける。

### 3.3 テナント分離の実装ガード

マルチテナントで最も致命的な事故は他家庭のデータが見えることなので、仕組みで防ぐ。

- 認証ミドルウェアが `c.set('familyId', ...)` を行い、**ハンドラは `c.get('familyId')` 以外から familyId を取らない**。URL・ボディ内の `familyId` は一切信用しない。
- DB アクセス層の全関数が第一引数に `familyId` を取り、`WHERE family_id = ?` を必ず含む。ハンドラから生SQLを書かない。
- 全エンドポイントに対して「他家庭のIDを指定すると 404 になる」テストを機械的に書く。ここはテストを1本ずつ手書きせず、ルート定義から自動生成する。

## 4. 技術構成

```
[ブラウザ / PWA]  React + Vite (SPA)
        │  fetch (Hono RPC で型共有)
        ▼
[Cloudflare Workers]  Hono
        ├── /api/*        …… API
        └── /*            …… Static Assets (SPA)
        │
        ▼
[Cloudflare D1]  SQLite
```

| レイヤ | 採用 | 理由 |
|---|---|---|
| ランタイム | Cloudflare Workers | 常時稼働のサーバ不要、無料枠内、日本からのレイテンシが低い |
| フレームワーク | Hono | Workers ネイティブ。`hono/client` でフロントと型を共有できる |
| DB | **D1** | SQL が使えるので履歴・集計が素直に書ける。`wrangler d1 export` でバックアップが取れる |
| フロント | React + Vite、Workers Assets で同一 Worker から配信 | CORS も別デプロイも不要。台帳UIはアニメーションが要るので SPA が向く |
| 配信形態 | PWA(ホーム画面に追加) | タブレットでアプリらしく全画面表示できる |
| 状態管理 | TanStack Query + 楽観更新 | シールは押した瞬間に描画し、通信は裏で走らせる |

### D1 を選ぶ理由と、Durable Object を選ばない理由

「家族ごとに Durable Object を1つ持ち、その中の SQLite に全部入れる」構成は Cloudflare 的には非常に綺麗で、強整合トランザクションと WebSocket 同期がタダで手に入る。テナントが完全に分離されるのでマルチテナント適性も高い。ただし今回は D1 を採る:

- 1家庭あたりのデータ量は年間で数千行しかない。整合性の難易度が低く、DO の強整合を必要としない。
- `wrangler d1 export` でバックアップ/復元が単純。子供の努力の記録を飛ばすのは許されない。他家庭のデータを預かるなら、なおさら復旧しやすさが要る。
- 後から集計クエリや、テナント横断の運用クエリ(利用状況の把握、問い合わせ対応)を SQL で書ける。DO に閉じ込めると、この横断が一気に苦しくなる。

**スケールの見積り**: 1家庭あたり年間およそ 1,000 grants / 1,500 stickers。テキストのみで1行あたり数百バイトなので、**数千家庭までは単一 D1 で余裕**(D1 の上限は 10GB/DB)。それを超えたら、`family_id` でハッシュ分割して D1 を複数持つ(アプリ側はすでに全クエリが family_id スコープなので、接続先を選ぶだけで済む)か、DO へ移す。**最初からシャーディングはしない。**

**D1 の制約への対処**: D1 にはインタラクティブトランザクションがない。付与処理(grant + stickers + sheet 更新 + 必要なら新 sheet 作成)は、ID をアプリ側で採番したうえで **`db.batch()` 1回にまとめて原子的に実行**する。`sheets` に `version` を持たせた楽観ロックで競合を検出し、負けたらリトライする。家庭内利用なので競合はまず起きないが、連打には効く。

### リアルタイム同期

Phase 1 では **WebSocket を使わない**。TanStack Query の refetchOnWindowFocus + 15秒ポーリングで十分(親が外出先で貼ったシールがタブレットに数秒で出る、程度で困らない)。

同席してリアクションを共有したくなったら、Phase 2 で家族ごとの Durable Object を WebSocket のブロードキャスト専用(データは持たせない)に足す。この分離なら D1 構成を壊さずに載せられる。

### 冪等性

タブレットで子供は必ず連打する。付与 API はクライアント生成の `request_id`(UUID)を必須にし、`grants.request_id` に UNIQUE 制約を張って二重送信を握りつぶす。

## 5. データモデル

```sql
-- ── テナント基盤 ───────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,          -- google / apple
  subject      TEXT NOT NULL,          -- プロバイダ側のユーザーID
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_provider_subject ON users(provider, subject);

CREATE TABLE families (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

-- 1ユーザーが複数の家庭に属せる(父母・別居の親・祖父母)
CREATE TABLE memberships (
  user_id    TEXT NOT NULL REFERENCES users(id),
  family_id  TEXT NOT NULL REFERENCES families(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','parent','viewer')),
  member_id  TEXT REFERENCES members(id),   -- 家庭内での表示上の人格
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, family_id)
);

-- 家庭ごとに変わるルール。コードに定数を埋めずここに置く
CREATE TABLE family_settings (
  family_id         TEXT PRIMARY KEY REFERENCES families(id),
  capacity          INTEGER NOT NULL DEFAULT 30,  -- 台帳1枚あたりのマス数
  require_approval  INTEGER NOT NULL DEFAULT 0,   -- 1 なら親の承認後にシール発行
  allow_self_grant  INTEGER NOT NULL DEFAULT 1,   -- 0 なら親しか貼れない
  self_revoke_sec   INTEGER NOT NULL DEFAULT 300, -- 子が自分で取り消せる猶予秒
  siblings_visible  INTEGER NOT NULL DEFAULT 1,   -- 兄弟の台帳が見えるか
  sticker_theme     TEXT NOT NULL DEFAULT 'default',
  locale            TEXT NOT NULL DEFAULT 'ja-JP',
  timezone          TEXT NOT NULL DEFAULT 'Asia/Tokyo'
);

-- ── 家庭内 ───────────────────────────────────
CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES families(id),
  name        TEXT NOT NULL,     -- ニックネーム推奨(UIで案内)
  role        TEXT NOT NULL CHECK (role IN ('child','parent')),
  avatar      TEXT,              -- 絵文字 or プリセット名
  color       TEXT,              -- 台帳のテーマカラー
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id),
  label         TEXT NOT NULL,   -- 「リビングのiPad」
  kind          TEXT NOT NULL CHECK (kind IN ('shared','child','parent')),
  member_id     TEXT REFERENCES members(id),  -- kind='child' のとき固定される子
  token_hash    TEXT NOT NULL UNIQUE,
  skip_pin      INTEGER NOT NULL DEFAULT 0,  -- parent 端末のみ許可
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE chores (
  id             TEXT PRIMARY KEY,
  family_id      TEXT NOT NULL REFERENCES families(id),
  name           TEXT NOT NULL,
  name_norm      TEXT NOT NULL,   -- 正規化キー(重複マージ用)
  emoji          TEXT,
  default_count  INTEGER NOT NULL DEFAULT 1,
  use_count      INTEGER NOT NULL DEFAULT 0,   -- 並び順用
  last_used_at   INTEGER,
  created_by     TEXT REFERENCES members(id),
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER
);
CREATE UNIQUE INDEX chores_family_norm ON chores(family_id, name_norm);

CREATE TABLE sheets (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families(id),
  member_id    TEXT NOT NULL REFERENCES members(id),
  seq_no       INTEGER NOT NULL,          -- その子の何冊目か
  capacity     INTEGER NOT NULL,          -- 発行時点の family_settings.capacity を固定
  status       TEXT NOT NULL CHECK (status IN ('active','full','redeemed')),
  version      INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  filled_at    INTEGER,
  redeemed_at  INTEGER
);
CREATE UNIQUE INDEX sheets_member_seq ON sheets(member_id, seq_no);
CREATE UNIQUE INDEX sheets_one_active ON sheets(member_id) WHERE status = 'active';

-- お手伝い1回の記録。シールを n 枚発行する単位であり、取り消しの単位でもある
CREATE TABLE grants (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id),
  member_id     TEXT NOT NULL REFERENCES members(id),
  chore_id      TEXT REFERENCES chores(id),
  chore_label   TEXT NOT NULL,     -- 記録時点の名前を凍結(後でメニューを直しても履歴は変わらない)
  count         INTEGER NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL REFERENCES members(id),
  created_via   TEXT NOT NULL CHECK (created_via IN ('self','parent')),
  request_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,           -- require_approval=0 なら created_at と同時にセット
  approved_by   TEXT REFERENCES members(id),
  revoked_at    INTEGER,
  revoked_by    TEXT REFERENCES members(id),
  revoke_reason TEXT
);
CREATE UNIQUE INDEX grants_request_id ON grants(request_id);

-- 台帳のマス1つ。台帳をまたいだ付与は同じ grant から複数 sheet に散る
CREATE TABLE stickers (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES families(id),
  grant_id    TEXT NOT NULL REFERENCES grants(id),
  sheet_id    TEXT NOT NULL REFERENCES sheets(id),
  position    INTEGER NOT NULL,   -- 1..capacity
  art         TEXT,               -- シールの絵柄
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
-- 有効なシールだけがマスを占有する(取り消すと穴が空き、次のシールが埋める)
CREATE UNIQUE INDEX stickers_slot ON stickers(sheet_id, position) WHERE revoked_at IS NULL;

CREATE TABLE redemptions (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families(id),
  sheet_id     TEXT NOT NULL UNIQUE REFERENCES sheets(id),
  member_id    TEXT NOT NULL REFERENCES members(id),
  reward_text  TEXT NOT NULL,      -- 「Robux 1200」「鬼滅の刃 20巻」
  category     TEXT,               -- roblox / minecraft / book / other
  amount_yen   INTEGER,            -- 任意
  requested_at INTEGER,            -- 子が「こうかんしたい」を押した時刻
  approved_by  TEXT NOT NULL REFERENCES members(id),
  approved_at  INTEGER NOT NULL
);

-- ── 画面の操作記録(§9)────────────────────────
-- 台帳の記録と違い、これは「消さずに残す」対象ではない。
-- 指標として見る窓のぶんだけ持ち、それより古いものは捨てる。
CREATE TABLE ui_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   TEXT NOT NULL REFERENCES families(id),
  session_id  TEXT NOT NULL,      -- ブラウザのタブ1つぶん
  seq         INTEGER NOT NULL,   -- セッション内の連番。再送の二重計上を防ぐ
  at          INTEGER NOT NULL,   -- 端末の時計のずれをサーバで補正済み
  screen      TEXT NOT NULL,      -- home / ledger / shelf / parent-*
  type        TEXT NOT NULL,      -- view/leave/step/action/flow/friction/error
  name        TEXT NOT NULL,      -- stick / undo / dead-tap …(こちらで決めた固定名)
  value       INTEGER,            -- 滞在ミリ秒、枚数、経過ミリ秒、タップ数
  detail      TEXT,               -- タブ名・場所の名前・エラーコード
  member_id   TEXT REFERENCES members(id),
  device_kind TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX ui_events_dedupe ON ui_events(session_id, seq);
CREATE INDEX ui_events_family_at ON ui_events(family_id, at);

-- family_settings に追加
--   ui_log_days INTEGER NOT NULL DEFAULT 90   -- 0 なら記録しない
```

### 設計上のポイント

- **`grants` と `stickers` を分ける。** 「1回のお手伝いで3枚」も「台帳をまたぐ3枚」も自然に表せる。取り消しは grant 単位(そのgrantの stickers を全て `revoked_at` にする)なので、UI上も「あのお手伝いを取り消す」という直感に一致する。
- **`chore_label` を grants に凍結する。** メニュー名を後から直しても、過去の履歴の表示が書き換わらない。
- **満了判定は `revoked_at IS NULL` のシール数 = `capacity`。** 部分ユニークインデックスにより、取り消しで空いたマスを次のシールが正しく埋める。
- **`sheets_one_active` 部分ユニークインデックス**で、1人1冊の active しか存在しえないことをDBで保証する。
- **`grants.approved_at` は承認なし運用でも必ず埋める。** 「シールが有効な条件 = `approved_at IS NOT NULL AND revoked_at IS NULL`」という判定式を最初から一本にしておけば、承認ありの家庭を後から受け入れてもクエリを書き換えずに済む。
- **全テーブルに `family_id` を持たせる**(`stickers` のように親を辿れば分かる場合も冗長に持つ)。JOIN を経由せずに `WHERE family_id = ?` が書けることが、テナント漏れ防止の実装ガードの前提になる。

## 6. API(Hono)

`/auth/*` を除く全エンドポイントで、**OAuth セッション Cookie か端末トークン Cookie のいずれか**を必須とする。ミドルウェアがどちらかを検証して `familyId` と実効権限を確定させ、以降のハンドラはそこだけを見る。親操作は、OAuth セッションがなければ `X-Parent-Pin` ヘッダ(または直前のPIN検証で発行した短命トークン)を要求する。

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/auth/:provider` / `/auth/:provider/callback` | 親の OAuth サインイン |
| `POST` | `/api/families` | 家庭を新規作成し、作成者を owner にする(オンボーディング) |
| `GET` | `/api/me` | サインイン中のユーザーと、所属する家庭の一覧 |
| `POST` | `/api/session/family` | 操作対象の家庭を切り替える(複数家庭に属する場合) |
| `GET` | `/api/bootstrap` | 家族・メンバー・メニュー・設定・各自の現在の台帳をまとめて返す(初回1発) |
| `GET` | `/api/members/:id/sheet` | 現在の台帳 + シール一覧 |
| `GET` | `/api/members/:id/sheets` | 本棚(交換済み台帳の一覧) |
| `GET` | `/api/members/:id/history` | 付与履歴(取り消し済みも含む) |
| `POST` | `/api/grants` | シールを貼る。`{memberId, choreId?, choreName?, count, requestId}` |
| `POST` | `/api/grants/:id/approve` | 承認(`require_approval = 1` の家庭のみ、親PIN) |
| `POST` | `/api/grants/:id/revoke` | 取り消し。直後(`self_revoke_sec` 以内)の自分の分は子も可、それ以外は親PIN |
| `GET` | `/api/chores` | メニュー(使用頻度順) |
| `POST` | `/api/chores` | メニュー追加(自由入力時にサーバ側で自動実行されるのと同じ経路) |
| `PATCH` | `/api/chores/:id` | 名前・絵文字・めやす枚数の変更、アーカイブ(親) |
| `POST` | `/api/sheets/:id/request-redeem` | 「こうかんしたい」 |
| `POST` | `/api/sheets/:id/redeem` | ハンコを押して交換確定(親PIN) |
| `GET/POST/DELETE` | `/api/devices` | 招待リンク発行・端末一覧・失効(親PIN) |
| `GET/PATCH` | `/api/settings` | 家庭ごとの設定(マス数・承認要否など、親PIN) |
| `GET` | `/api/stats` | 期間別・お手伝い別の集計 |
| `POST` | `/api/ui-events` | 画面の操作記録を受け取る(§9)。誰でも書ける |
| `GET` | `/api/insights` | 操作記録の集計。生のイベントは返さない(親PIN) |
| `DELETE` | `/api/ui-events` | 操作記録を全部消す(親PIN) |
| `GET` | `/api/export` | 家庭の全データを JSON で書き出す |
| `DELETE` | `/api/families/:id` | 家庭とその全データを削除(owner のみ、確認つき) |

### 付与処理の擬似コード

```
POST /api/grants { memberId, chore, count, requestId }

1. requestId が既存なら、その grant をそのまま返す(冪等)
2. member の active sheet と、その有効シール数を取得
3. chore が新規名なら chores に UPSERT(name_norm で既存にマージ)
4. count 枚を、空きマスの若い順に割り当てる。
   足りなければ現 sheet を full にし、次の sheet を採番して続きを割り当てる
5. 以下を db.batch() で一括実行:
     INSERT grants
     INSERT stickers × count
     UPDATE sheets SET version = version + 1 (+ 必要なら status='full', filled_at)
     INSERT sheets (繰り越しが発生した場合)
     UPDATE chores SET use_count = use_count + 1, last_used_at = ?
   ※ UPDATE sheets には WHERE version = <読み取り時の値> を付ける
6. 更新行数0(= 競合)なら 2 からリトライ(最大3回)
```

## 7. 画面

### 子の画面(共有タブレット / 各自のスマホ)

1. **だれ?** — 顔アイコンを2つ並べただけの選択画面。タップで台帳へ。
2. **台帳** — 6×5=30マスのグリッド。埋まったマスにシール。下部に大きな「おてつだいした!」ボタン。上部に「あと◯枚」。
3. **お手伝いを選ぶ** — メニューのボタン一覧(絵文字つき、頻度順)+「そのほか」。
4. **貼る** — 大きなシールボタン。押すたびに1枚、音とアニメーション付きで台帳に飛んでいく。「1枚もどす」が隣にある。
5. **こうかんできる!** — 30枚埋まると台帳が光る。「こうかんしたい」で親へ。
6. **本棚** — 過去の台帳が背表紙のように並ぶ。タップすると当時の台帳と交換したものが見られる。

### 親の画面

- 2人の台帳の進捗を並べて表示。「こうかんまち」バッジ。
- 誰かに代わってシールを貼る(子の画面と同じフロー、対象を選ぶだけ)。
- 履歴タイムライン(誰が・いつ・何を・何枚・誰が貼ったか)。ここから取り消し。
- 交換のハンコ画面(PIN → 交換内容入力 → ハンコ演出)。
- 設定: メニュー編集、マス数、PIN、端末管理、招待リンク発行。

### 演出について

紙のシール帳の楽しさは「貼る瞬間」と「埋まっていく見た目」にある。ここは削らない。

- シールが指から台帳に飛んで、軽く跳ねて止まる。
- 貼るたびに音。10枚ごと、20枚ごとに小さなお祝い。
- 30枚目で全画面の紙吹雪。
- 交換時のハンコは、親がPIN後に画面を押し込むと朱肉のように押される。

## 8. 他家庭への展開

### 8.1 最初からやること(後から入れると作り直しになるもの)

| 項目 | 理由 |
|---|---|
| 全テーブルの `family_id` とスコープ強制 | 後付けは全クエリの見直しになる。事故ったときの被害が大きい |
| `users` / `memberships` と OAuth | 家庭の所有者が決まっていないと、後から権限を後付けできない |
| `family_settings`(マス数・承認要否など) | ルールをコードに定数で埋めると、他家庭対応が全面改修になる |
| `grants.approved_at` | 「有効なシール」の判定式を最初から一本にしておく |
| 家庭の新規作成オンボーディング | 自分の家は手で INSERT すればいいが、そのぶん導線が育たない |

### 8.2 あとでよいこと

自分の家で回すうちは要らない。他家庭に開くと決めた時点で着手する。

- 利用規約・プライバシーポリシー
- 問い合わせ窓口、障害時の告知手段
- サインアップ後のチュートリアル、お手伝いメニューの初期プリセット(家庭によって全然違うので、いくつかテンプレを用意して選ばせる)
- 招待の受け取り側 UX(配偶者を家庭に招く導線。今は端末招待しかない)
- 利用状況の把握(アクティブ家庭数、継続率)。個人データを見ずに済む集計だけにする。§9 の `ui_events` は家庭ごとに閉じているので、横断で見るならテナント横断の集計を別に用意する
- 課金するなら決済。ただし**無料で運用できる規模のうちは課金を入れない**方がよい。有料にした瞬間に SLA とサポート義務が発生する

### 8.3 他家庭に開くときの、うちとの前提の違い

うちの運用は「30枚」「自己申告」「用途は縛らない」だが、これは相当ゆるい部類。他家庭では以下が普通に要求される想定で、設定として吸収できるかを都度確認する。

- 承認必須(`require_approval`)
- 子は貼れない・親だけが貼る(`allow_self_grant`)
- 台帳のマス数が違う(20枚、50枚、100枚)
- お手伝いごとに枚数が違う(`chores.default_count` で対応済み)
- ポイントを金額換算する運用(1枚=10円など)。**これは今のモデルに入っていない。**入れるなら `family_settings.point_value_yen` と、交換時の自動計算。ただし「好きなものと交換」という体験を金銭に変えてしまう副作用があるので、入れるかどうかは慎重に

### 8.4 プライバシーと法務

子供の記録を他家庭のぶんまで預かるので、ここは軽く見ない。

- **子供にアカウントを作らせない設計を維持する。** 子の識別子は家庭内でしか意味を持たない表示名だけ。生年月日・メール・写真を必須にしない。これだけで、日本の個人情報保護法上も COPPA 相当の海外規制上もリスクが大きく下がる。
- 名前欄にはニックネームを推奨する案内を出す。
- 写真添付(Phase 3)を入れるなら R2 に家庭ごとのプレフィックスで保存し、**公開URLを作らない**(署名付きURLのみ)。ここが一番事故りやすい。
- 家庭の削除で、その家庭の全行と R2 オブジェクトを本当に消す。`DELETE /api/families/:id` を機能として持つ。§9 の操作記録も同じ扱いにする(消せないものを増やさない)。
- **操作記録に自由入力を入れない。** 集計に要らないものを持たなければ、預かる情報そのものが減る。詳細は §9.2。
- エクスポート(`GET /api/export`)を用意する。「いつでも自分のデータを持ち出せる」ことは、他人の家庭の記録を預かるうえでの最低条件。

## 9. 画面の操作記録(UI を直すための指標)

紙をアプリに置き換えた以上、「紙より使いにくくなっていないか」を確かめる手段が要る。
そして**子供は「使いにくい」と言葉にしない。黙って押すのをやめるだけ**なので、操作を見るしかない。

### 9.1 外に出さない。だから自前で持つ

原則4「家族の外には一切出さない」がある以上、外部の解析サービスは使わない。GA を1行入れた時点でこの設計は崩れる。

保存先は Analytics Engine ではなく **D1**:

- `/api/export` と家庭の削除にそのまま乗る。「消したら本当に消える」を操作記録にも適用できる。Analytics Engine は家庭単位で消せない
- `grants` と同じ SQL で突き合わせられる(「シールを貼った日の操作」など)
- 1家庭あたり日に数百行。容量も書き込み数も無料枠に収まる

### 9.2 集めるものと、集めないもの

**集める**: こちらで名前を決めた固定の識別子と、数値だけ。

| 種別 | 例 | 何のため |
|---|---|---|
| `view` / `leave` | ledger に入った・出た(滞在ミリ秒) | どの画面で止まっているか |
| `action` | stick / undo / chore-pick / request-redeem | 何が使われ、何が使われていないか |
| `flow` | first-sticker(ミリ秒)、first-sticker-taps(回数) | 目的達成までの遠さ |
| `friction` | dead-tap / rage-tap / revisit / undo-fast / pin-wrong | どこで詰まったか |
| `error` | サーバのエラーコード | 子供の前で失敗した回数 |

1件ごとの内容に加えて、送信1回ごとに**どこから来た記録か**を付ける。

| 付けるもの | 何のため |
|---|---|
| `device_id` | 使われているのに記録が来ていない端末を見つける。`device_kind` だけでは子供用が2台あると区別が付かない |
| `app_version` | ホーム画面から開いたままの端末が、古いビルドで動き続けていないかを見る |

どちらもこちらで払い出した固定のID。端末そのものの情報(UserAgent など)ではない。

**集めない**: 自由入力の中身(お手伝いの名前・交換したもの・メモ)、URL、UserAgent、IPアドレス、タップ座標。

これを運用の約束にしない。**サーバが `screen` / `name` / `detail` を `[A-Za-z0-9_:-]` に限る。**
日本語が入る = 自由入力が混ざった、ということなので 400 で落ちる。
うっかり `detail: chore.name` と書いたら、その場でテストが赤くなる。

場所の名前は `data-zone` 属性でだけ取る(`sheet-grid`、`chore-picker` など)。
「台帳のマスを押そうとした子が18回いた」までは分かり、それ以上のことは分からない、という粒度にしてある。

### 9.3 何を見て、どう直すか

数字を出すだけでは手が動かないので、指標は「直し方が決まるもの」に絞る。

| 指標 | 読み方 |
|---|---|
| 台帳を開いた → 選んだ → 貼った の減り方 | 落ちている段が、いちばん直す価値のある段 |
| 1枚目までの秒数とタップ数 | 遠いなら、お手伝いの選択が邪魔をしている |
| 反応しない場所へのタップ(場所つき) | 押せるようにするか、押せなさそうな見た目にする |
| 貼ってすぐ「もどす」 | 貼るつもりが無かった。ボタンが近すぎる |
| 開いてすぐ引き返す | 目当てのものがそこに無い。前の画面から分かるようにする |
| 「そのほか」の入力をやめた | メニューが足りない。よく使うものを最初から載せる |
| PIN の失敗・中断 | PIN を出す場面が多すぎないか |

子ごとにも出す。**同じ画面でも、5歳と10歳では詰まる所が違う。**

### 9.4 実装で決めたこと

- **記録が画面を描き直さない。** `src/client/lib/telemetry.ts` は ref とイベントリスナだけで動く。記録のために再レンダリングが起きたら本末転倒
- **`startTelemetry()` は `main.tsx` からしか呼ばない。** 呼ぶまで `track()` は完全な no-op。画面テストは main.tsx を通らないので、テスト中に勝手な通信が起きない
- **送信は溜めてから。** 20件・10秒・画面を離れるとき(`sendBeacon`)。投げっぱなしなので取りこぼすことがある。**母数として使い、絶対数の正確さには頼らない**
- **(`session_id`, `seq`) に UNIQUE。** `sendBeacon` は結果が分からず再送も起きるので、二重計上は DB で潰す
- **不正な行は、その行だけ捨てる。** 以前はバッチごと 400 で落としていたが、端末は再送しないので
  1件のせいで同じ送信の全部が消えていた。捨てた件数は `error: dropped` として残す。
  **「うっかり自由入力を混ぜたら落ちる」性質はここで保つ**(捨てられたことが集計に出る)
- **セッションは無操作30分で切る。** タブ1つを1セッションにしていたら、開きっぱなしの端末で
  50時間ぶんが1セッションになり、セッション数もファネルも実態を映さなくなっていた
- **時間は「見えていた間」だけ数える。** 背面に回っている間は滞在時間に積まない。
  ここを数えていたせいで、滞在に39時間・1枚目までに29時間という値が入っていた
- **画面を移った(`exit`)と、タブごと離れた(`hide`)を分ける。** `hide` が多い画面が、そこで止まっている画面
- **失敗の記録は `api.ts` の1か所。** 画面ごとの `catch` に任せていたときは、
  台帳データの取得そのものが失敗した場合(= 画面が出ないまま終わる)がどこにも残らなかった
- **端末の時計を信じない。** 「送信時点の端末時刻」との差でサーバの時計に寄せる。時刻が年単位でずれたタブレットが1台あるだけで、集計が壊れるため
- **保持日数は `family_settings.ui_log_days`。** 0 で記録そのものを止める。古い行は書き込みのついでに消す(掃除のためだけに Cron を増やさない)
- **止める・消すを、集計と同じ画面に置く。** 子供の操作記録を持つ以上、設定の奥に隠さない

### 9.5 分かっていない範囲

- **オンボーディングは記録できない。** 家庭ができるまで `familyId` が確定せず、記録の置き場が無い。他家庭に開くときいちばん見たい所なので、Phase 3 で「家庭の作成時にまとめて紐づける」形で入れる
- 連打してよい所(シールボタン)は `data-rage-ok` で連打の検出から外している。ここを数えると、いちばん健全な操作が最大の問題として並んでしまう
- 開発ビルドは StrictMode で `view` が二重に出る。本番ビルドでは起きない

## 10. 開発フェーズ

### Phase 1(MVP)— 自分の家で紙を置き換える
- Google サインイン、家庭の新規作成、メンバー登録、招待リンクによる端末登録
- 台帳・シール付与(連続タップ・複数枚・台帳またぎ)
- お手伝いメニュー(自由入力で自動追加、頻度順)
- 親PIN、取り消し、交換ハンコ、本棚
- `family_settings` は作るが、UI は最小(マス数だけ)
- PWA 化、Cloudflare へデプロイ

### Phase 2 — 自分の家で定着させる
- Web Push 通知(「こうかんまち」を親へ / 親が貼ったら子へ)。ホーム画面追加済み PWA なら iOS でも届く
- 集計画面(今月の枚数、よくやったお手伝いランキング、兄弟の推移)
- 画面の操作記録と「つかわれかた」(§9)。定着しないときに、理由を推測でなく数で当てるため
- シール絵柄のバリエーション、レア絵柄
- Durable Object による WebSocket リアルタイム反映
- 設定画面の作り込み(承認要否・自己申告可否など、他家庭で必要になる項目)

### Phase 3 — 他家庭に開く
- オンボーディング(家庭作成〜初回のシールまでを迷わせない)、メニューのプリセット
- 配偶者の招待、複数家庭の切り替え
- 利用規約・プライバシーポリシー・問い合わせ導線
- エクスポート / 家庭の削除
- テナント分離のテストを全ルートに敷く

### Phase 4 — 欲が出たら
- 「次はこれと交換したい」の目標設定と、そこまでの残り枚数表示
- お手伝いの写真添付
- 定期的なお手伝い(毎日の◯◯)のリマインド

## 11. 運用

- **バックアップ**: Cron Trigger で毎日 D1 のスナップショットを R2 に保存する。子供の記録を失わないことが最優先で、他家庭のぶんを預かるならなおさら。復元手順を書いて、一度は実際に試しておく。
- **コスト**: 自分の家だけなら Workers / D1 の無料枠に完全に収まる。数千家庭規模でも Workers Paid($5/月)+ R2 の実費程度。カスタムドメイン代は別。
- **シードデータ**: 紙の台帳に現在貼ってある枚数を、セットアップ時に初期値として投入できるようにする(移行時に台帳がリセットされると子供が納得しない)。他家庭にも同じ移行需要があるので、これは機能として作る価値がある。
- **マイグレーション**: 他家庭が使い始めたらスキーマの後方互換が必須になる。Phase 1 の段階から `migrations/` に番号付きSQLを積む運用にしておく(wrangler の D1 マイグレーション機能をそのまま使う)。
