-- 画面の操作記録。UI を直すための指標としてだけ使う。
--
-- 何のために持つか:
--   紙より使いにくくなっている所を、印象ではなく数字で見つける。
--   「どの画面で止まるか」「1枚目のシールまで何秒かかるか」「どこを空振りでタップしたか」。
--
-- 何を入れないか:
--   自由入力の中身(お手伝いの名前、交換したもの、メモ)、URL、UserAgent、IPアドレス。
--   入れてよいのは、こちら側で名前を決めた固定の識別子と数値だけ。
--   ハンドラ側で screen / name / detail を [A-Za-z0-9_:-] に限っていて、
--   日本語が入る = 自由入力が混ざった、という形で弾けるようにしてある。
--
--   子供の操作記録を預かる以上、集計に要らないものは最初から集めない。
--   これは運用の約束ではなく、書き込み経路の制約として持たせる。

CREATE TABLE ui_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   TEXT NOT NULL REFERENCES families (id),
  -- ブラウザのタブ1つぶんの通し。端末をまたいで同じ値にはならない
  session_id  TEXT NOT NULL,
  -- セッション内の連番。並べ直しと、再送の二重計上防止を兼ねる
  seq         INTEGER NOT NULL,
  -- 発生時刻。端末の時計のずれはサーバ側で補正してから入れる
  at          INTEGER NOT NULL,
  screen      TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (
                type IN ('view', 'leave', 'step', 'action', 'flow', 'friction', 'error')
              ),
  name        TEXT NOT NULL,
  -- 数値の付随情報(滞在ミリ秒、枚数、経過ミリ秒、タップ数)
  value       INTEGER,
  -- 分類ラベル(タブ名、エラーコードなど)。自由文は入らない
  detail      TEXT,
  -- 対象の子。完全削除された人の行は NULL に落とす(purgeMember)
  member_id   TEXT REFERENCES members (id),
  device_kind TEXT,
  created_at  INTEGER NOT NULL
);

-- 送信の再試行が二重に積まれないようにする。冪等性はここで担保する
CREATE UNIQUE INDEX ui_events_dedupe ON ui_events (session_id, seq);
CREATE INDEX ui_events_family_at ON ui_events (family_id, at);
CREATE INDEX ui_events_family_type ON ui_events (family_id, type, at);

-- 記録の保持日数。0 にすると記録そのものを止める。
-- 台帳の記録と違って「消さずに残す」対象ではない。指標として見る窓のぶんだけあればよい。
ALTER TABLE family_settings ADD COLUMN ui_log_days INTEGER NOT NULL DEFAULT 90;
