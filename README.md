# おてつだいポイント

紙のシール台帳でやっている「お手伝いポイント」制度を、スマホ・タブレット・PC から使えるようにしたもの。

- 子はお手伝いを選んでシールを貼る(自己申告、押した回数だけ貼られる)
- 30枚たまったら親がハンコを押して好きなものと交換する
- 交換ずみの台帳は「本棚」に残り、何と交換したかも一緒に見られる
- 画面の操作を記録して、おうちの人の「つかわれかた」から使いにくい所を見つける

設計の背景と判断の理由は [DESIGN.md](./DESIGN.md) に書いてある。**実装で迷ったらまずそちらを読む。**

## 技術構成

| レイヤ | 採用 |
|---|---|
| ランタイム | Cloudflare Workers |
| API | Hono |
| DB | Cloudflare D1 (SQLite) |
| フロント | React + Vite(同じ Worker から配信)、PWA |
| スタイル | Tailwind CSS v4 |

## ローカルで動かす

```bash
npm install

# 環境変数を用意する(.dev.vars は git に入らない)
cp .dev.vars.example .dev.vars
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# ↑ を .dev.vars の SESSION_SECRET= に貼る

npm run migrate:local     # D1 にスキーマを流す
npm run dev               # http://localhost:5173
```

初回は「開発用サインイン(ローカルのみ)」のボタンから入る。Google のクライアントIDが無くても、
ローカルではこのボタンで一通り動かせる。

ポイント2倍デーの通知(Web Push)を試すときは、`npm run vapid` の出力3行をそのまま
`.dev.vars` に貼る。鍵が無くても通知以外はふつうに動く(送信だけが省略される)ので、
これは壊れた状態ではなく、ローカルの通常状態として扱ってよい。

### よく使うコマンド

```bash
npm run dev            # 開発サーバ
npm run build          # 型チェック + ビルド
npm run db:reset       # ローカル D1 を作り直す(dev サーバは止めてから)
npm run vapid          # 通知用の VAPID 鍵を作る(初回のみ)
npm test               # 単体 + 画面 + API 結合(サーバは自動で起きる)
npm run test:e2e       # 実ブラウザでの通し(Playwright)
npm run test:all       # 上の2つを順に
npm run deploy         # Cloudflare へデプロイ
```

## テスト

4層に分けてある。速いものから落ちるようにしてあるので、失敗した層を見れば原因の範囲がすぐ絞れる。

| 層 | 場所 | 何を見るか | 目安 |
|---|---|---|---|
| 単体 | `tests/unit` | 割り当てロジック、PIN のハッシュ、Cookie 署名の改竄検出、名前の正規化、集計の中央値 | 数秒 |
| 画面 | `tests/dom` | 台帳・親画面・PIN・オンボーディング・操作記録のふるまい(API はモック) | 十数秒 |
| API 結合 | `tests/api` | 実際の Worker + D1。台帳・認証・承認あり運用・同時実行・操作記録 | 1〜2分 |
| E2E | `e2e` | 実ブラウザ(WebKit / iPad 相当)での通し | 2分ほど |

`npm test` は Vitest の3層をまとめて走らせる。API 結合テストは
**自分でローカル D1 を作り直して dev サーバを起こす**(ポート 5174)ので、
`npm run dev` を別で動かしていても衝突しない。
Playwright も同様に自前でサーバを起こす(ポート 5175)。

初回だけブラウザの取得が要る:

```bash
npx playwright install webkit
```

とくに次のあたりは、手で再現するのが面倒なので機械的に押さえている:

- 台帳をまたぐ付与と、**繰り越しても渡す前の台帳が画面から消えないこと**
- 取り消しでマスに穴が空き、次のシールがそこを埋める
- 連打による二重送信が1件にまとまる
- 並行して貼っても、1枚も失われず同じマスが二重に埋まらない
- 招待リンクが使い捨てで、子ども専用端末はきょうだいの台帳を触れない
- 正しく署名された**他家庭の Cookie でも入れない**こと
- **他家庭のデータが一切見えない**こと(読み・書き・削除の全経路)
- 操作記録に**自由入力が混ざらない**こと(日本語が来たら 400)、再送しても二重に数えないこと
- 実ブラウザで、画面を離れるときに操作記録が送り切れていること(`sendBeacon` は
  jsdom に無いので、ここは E2E でしか確かめられない)

## 本番へ出す

手順は [DEPLOY.md](./DEPLOY.md) にまとめてある。

**ひとつだけ絶対に守ること**: `wrangler.jsonc` に `ENVIRONMENT` を書かない。
開発用サインイン(PIN もパスワードも要らない)が本番で有効になり、
URL を知っている誰でもログインできてしまう。

## 構成

```
src/
  shared/types.ts     … クライアントと Worker が共有する API の型
  worker/
    index.ts          … ルートの組み立て。認証の適用順もここ
    auth/             … OAuth・端末 Cookie・PIN
    db/               … DB アクセス。全関数が familyId を第一引数に取る
    routes/           … API ハンドラ
    lib/              … 暗号・エラー・バリデーション
  client/
    screens/          … 画面(台帳・本棚・親・つかわれかた・オンボーディング)
    components/       … 台帳グリッド、紙吹雪
    lib/telemetry.ts  … 画面の操作記録。startTelemetry() は main.tsx だけが呼ぶ
migrations/           … D1 のスキーマ。番号順に積んでいく
tests/
  unit/               … 純粋なロジック
  dom/                … 画面(jsdom + Testing Library)
  api/                … 実 Worker + D1 への結合テスト。server.ts が dev サーバを起こす
e2e/                  … 実ブラウザでの通し(Playwright)
```

## 触るときに壊しやすいところ

- **`familyId` は `getAuth(c).familyId` からしか取らない。** URL やリクエストボディの家庭IDを
  信用すると、他家庭のデータが見える。DB 層は必ず `WHERE family_id = ?` を含める。
- **付与処理は `db.batch()` 1回にまとめる。** D1 にインタラクティブトランザクションが無いため。
  競合の検出はスキーマの部分ユニークインデックスに任せていて、落ちたら読み直して再試行する。
  文の順序も意味を持つ(`sheets_one_active` があるので、次の台帳を作る前に現在の台帳を full にする)。
- **「有効なシール」の判定は `approved_at IS NOT NULL AND revoked_at IS NULL`。** 承認なし運用でも
  `approved_at` は必ず埋める。承認ありの家庭を後から受け入れてもクエリを書き換えずに済む。
- **家庭ごとに変わるルールは `family_settings` に置く。** マス数や承認要否をコードに定数で書かない。
- **裏での再取得で、画面を作り直さない。** `App` は bootstrap の「確定した」状態だけを見て
  画面を選ぶ(`useSettledBootstrap`)。再取得の途中で読み込み中の表示に切り替えると、
  その下の画面ごと React に捨てられ、入力途中のフォームが消える。実際に一度やらかしている。
- **GET に副作用を持たせない。** 招待リンクを開いた(GET)だけで端末を登録していたら、
  LINE のリンクプレビューに使い切られた。リンクを開くのは本人とは限らない
  (プレビュー取得、メールのスキャン、ブラウザの先読み)。状態を変えるなら POST。
- **招待リンクは、どのブラウザで開かれるかまで面倒を見る。** LINE のリンクは既定で
  アプリ内ブラウザで開き、そこで登録した Cookie は Safari や Chrome には残らない。
  `openExternalBrowser=1`(`src/client/lib/inviteUrl.ts`)で外部ブラウザに逃がしている。
  いちばん確実なのは QR コードをカメラで読んでもらう渡し方。
- **重い計算を足す前に、Workers 上で実測する。** CPU 時間の上限は1リクエスト 10ms(無料プラン)。
  手元の開発サーバには上限が無いので、本番だけ 500 になる。PIN のハッシュ化で踏んでいる。
- **操作記録に自由入力を入れない。** `screen` / `name` / `detail` はサーバが
  `[A-Za-z0-9_:-]` しか受け付けない。`detail: chore.name` のようなうっかりは
  400 になり、テストが落ちる。**この制約を緩めない**(緩めた瞬間に、お手伝いの名前や
  交換したものが記録に混ざる)。詳しくは [DESIGN.md](./DESIGN.md) §9。
- **記録のために画面を描き直さない。** `useScreen` も `track` も state を持たない。
  記録が原因で再レンダリングが起きたら、指標のために体験を悪くしていることになる。

## つかわれかたを見る

おうちの人のがめん → **つかわれかた**。どの画面で止まっているか、押しても反応しなかった
場所はどこか、1枚目を貼るまで何秒かかっているかが出る。同じ画面から記録を止められるし、
これまでのぶんを消せる。

手で掘るなら D1 を直接見る:

```bash
npx wrangler d1 execute otetsudai-point --local --command \
  "SELECT screen, name, COUNT(*) n FROM ui_events WHERE type='friction' GROUP BY 1,2 ORDER BY n DESC"
```
