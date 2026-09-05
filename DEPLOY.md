# デプロイ手順

Cloudflare Workers に出す。無料枠に収まる規模なので、費用はドメイン代だけ(独自ドメインを使う場合)。

前提: Cloudflare アカウントと、`npx wrangler login` が済んでいること。

## 1. D1 を作る

```bash
npx wrangler d1 create otetsudai-point
```

払い出された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に書く
(初期値は `local-dev-placeholder`。ローカル開発ではこのままで動く)。

```bash
npm run migrate:remote
```

## 2. シークレットを設定する

```bash
# Cookie の署名鍵。これが漏れると、他人の家庭に入れる Cookie を作られる
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put SESSION_SECRET

npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# 通知(ポイント2倍デーの Web Push)を使う場合のみ。npm run vapid で作った3行を
# 1行ずつ入れる(VAPID_SUBJECT は mailto:you@example.com のような値)
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`SESSION_SECRET` が未設定だと、アプリは起動せず 500 を返す。
署名鍵なしで Cookie を配るくらいなら、動かないほうがましなので意図的にそうしてある。

`VAPID_*` の3つは未設定でも起動する。通知の送信だけが省略され、
ポイント2倍デーそのもの(帯の表示、シールが2倍貼られること)はふつうに動く。
あとから通知だけ足したくなったら、このコマンドを流すだけでよい。

> **`ENVIRONMENT` は設定しないこと。**
> 開発用サインイン(`/auth/dev`。PIN もパスワードも要らない)は
> `ENVIRONMENT === "development"` のときだけ有効になる。
> 本番で設定すると、URL を知っている誰でもログインできる。
> `wrangler.jsonc` に書かれていないことを機械的に確かめるテストがある(`tests/unit/config.test.ts`)。

`APP_ORIGIN` も通常は不要。リクエストの URL から自動で判定する。

> **Cron(毎時0分)は `wrangler.jsonc` の `triggers.crons` で設定される。**
> デプロイするだけで有効になるが、デプロイ後に一度だけ Cloudflare のダッシュボードで
> Trigger が登録されていることを確認しておく。「朝8時に送る」という判定自体は
> Cloudflare 側ではなく、家庭ごとのローカル時刻で毎時アプリ側が判定している
> (Cloudflare の cron は UTC 固定で、家庭の時差までは面倒を見てくれないため)。
>
> **iOS / iPadOS で通知を受け取るには、16.4 以降かつ「ホーム画面に追加」した
> PWA として開いている必要がある。** Safari のタブで開いている状態では、
> 台帳の帯に「おしらせを うけとる」ボタンそのものが出ない(仕様どおり)。

## 3. 先にデプロイして、URL を確定させる

Google の設定に URL が要るので、先に一度出す。

```bash
npm run deploy
```

`https://otetsudai-point.<アカウント名>.workers.dev` が払い出される。
独自ドメインを使うなら、Cloudflare のダッシュボードでここに割り当ててから次に進む。

## 4. Google OAuth を設定する

[Google Cloud Console](https://console.cloud.google.com/apis/credentials) で
「OAuth 2.0 クライアント ID」を作る(種類: ウェブアプリケーション)。

| 項目 | 値 |
|---|---|
| 承認済みの JavaScript 生成元 | `https://<公開URL>` |
| 承認済みのリダイレクト URI | `https://<公開URL>/auth/google/callback` |

OAuth 同意画面は「外部」でよいが、**テストユーザーに自分たちのアカウントを登録するだけで足りる**。
家族しか使わないうちは、審査に出す必要はない。

クライアント ID とシークレットを手順2で設定していなければ、ここで設定してもう一度 `npm run deploy`。

## 5. 動作を確認する

1. 公開 URL を開き、Google でログインする
2. 家庭を作る(家族の名前、親の名前、PIN、子どもの名前)
3. 子の台帳を開き、シールを1枚貼る
4. せってい → 共有タブレット用のリンクを発行し、**別の端末**で開く
5. その端末から親の操作(交換のハンコなど)をして、PIN を求められることを確かめる
6. ホーム画面に追加して、ブラウザの枠なしで開くことを確かめる

## 6. バックアップを仕込む

子どもの記録を失うのが、このアプリでいちばん困る事故。

```bash
# 手元に落とす場合
npx wrangler d1 export otetsudai-point --remote --output backup-$(date +%Y%m%d).sql
```

定期的に取るなら、Cron Trigger から R2 に書き出す Worker を足す(Phase 2)。
**復元手順は、一度実際に試しておくこと。** 試していないバックアップは無いのと同じ。

---

## 出す前のチェック

```bash
npm run build      # 型チェックとビルド
npm run test:all   # 単体・画面・API・実ブラウザ
```

- [ ] `wrangler.jsonc` の `database_id` が本物になっている
- [ ] `wrangler.jsonc` に `ENVIRONMENT` が **無い**
- [ ] `SESSION_SECRET` を設定した(ローカルの `.dev.vars` とは別の値にする)
- [ ] Google のリダイレクト URI が公開 URL と一致している
- [ ] `dist/` を配布物として誰かに渡していない(ローカル用の `.dev.vars` が入る)

## 更新するとき

```bash
npm run build && npm run deploy
```

スキーマを変えたときは、`migrations/` に**新しい番号のファイルを足す**
(既存のファイルは直さない。適用済みの環境では再実行されないため)。

```bash
npm run migrate:remote
```

利用者が自分の家だけのうちは気楽だが、他家庭が使い始めたら
「古いクライアントが動いたまま新しいスキーマになる」瞬間があることを前提に、
列の削除や意味の変更は避けて、足す方向で変えていく。

## つまずきやすいところ

| 症状 | 原因 |
|---|---|
| `/api/*` が index.html を返す | `assets.run_worker_first` から `/api/*` が抜けている |
| ログイン後に `redirect_uri_mismatch` | Google 側のリダイレクト URI が公開 URL と違う |
| 500 と「SESSION_SECRET が設定されていません」 | 手順2をやっていない |
| ログインし直すと家庭が見つからない | 別の Google アカウントで入っている(家庭は作成者に紐づく) |
| 招待リンクが `localhost` を指す | `APP_ORIGIN` に古い値が設定されている。消せばリクエストから判定する |
| 家庭の作成や PIN の検証だけが 500 | CPU 時間の超過。下記参照 |

### CPU 時間について

Workers には1リクエストあたりの CPU 時間の上限がある(**無料プランで 10ms**)。
ローカルの開発サーバには上限が無いので、**手元では動くのに本番だけ落ちる**という形で出る。
ランタイムに落とされた場合、こちらのエラーハンドラは動かないため、
アプリのログには何も残らず、Cloudflare 側の例外(`Worker exceeded resource limits`)になる。

実際に、PIN のハッシュ化(PBKDF2 21万回 = 112ms)でこれを踏んで、家庭の作成が 500 になった。
いまは反復回数を落とし、そのぶんをペッパー(サーバ側の秘密鍵)で補っている
(`src/worker/lib/crypto.ts` に理由を書いてある)。

重い処理を足すときは、Workers 上での実測を確かめること。ログを見るなら:

```bash
npx wrangler tail --format pretty
```
