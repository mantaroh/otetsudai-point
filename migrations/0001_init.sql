-- おてつだいポイント 初期スキーマ
-- 設計の詳細は DESIGN.md を参照。
--
-- 方針:
--   * 全テーブルに family_id を持たせる(親を辿れば分かる場合も冗長に持つ)。
--     JOIN を経由せずに WHERE family_id = ? が書けることが、テナント分離の実装ガードの前提。
--   * 時刻は全て UNIX epoch ミリ秒の INTEGER。
--   * 削除はしない。無効化(revoked_at / archived_at / deleted_at)で表す。

-- ── テナント基盤 ───────────────────────────────

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,          -- google / apple / dev
  subject      TEXT NOT NULL,          -- プロバイダ側のユーザーID
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_provider_subject ON users (provider, subject);

CREATE TABLE families (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  pin_hash         TEXT NOT NULL,
  -- PIN の総当たり対策。家庭単位でロックする
  pin_failed_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES families (id),
  name        TEXT NOT NULL,          -- ニックネーム推奨(UIで案内する)
  role        TEXT NOT NULL CHECK (role IN ('child', 'parent')),
  avatar      TEXT,                   -- 絵文字
  color       TEXT,                   -- 台帳のテーマカラー
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX members_family ON members (family_id, sort_order);

-- 1ユーザーが複数の家庭に属せる(父母・別居の親・祖父母)
CREATE TABLE memberships (
  user_id   TEXT NOT NULL REFERENCES users (id),
  family_id TEXT NOT NULL REFERENCES families (id),
  role      TEXT NOT NULL CHECK (role IN ('owner', 'parent', 'viewer')),
  member_id TEXT REFERENCES members (id),   -- 家庭内での表示上の人格
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, family_id)
);
CREATE INDEX memberships_family ON memberships (family_id);

-- 家庭ごとに変わるルール。コードに定数を埋めずここに置く
CREATE TABLE family_settings (
  family_id        TEXT PRIMARY KEY REFERENCES families (id),
  capacity         INTEGER NOT NULL DEFAULT 30,   -- 台帳1枚あたりのマス数
  require_approval INTEGER NOT NULL DEFAULT 0,    -- 1 なら親の承認後にシール発行
  allow_self_grant INTEGER NOT NULL DEFAULT 1,    -- 0 なら親しか貼れない
  self_revoke_sec  INTEGER NOT NULL DEFAULT 300,  -- 子が自分で取り消せる猶予秒
  siblings_visible INTEGER NOT NULL DEFAULT 1,    -- 兄弟の台帳が見えるか
  sticker_theme    TEXT NOT NULL DEFAULT 'default',
  locale           TEXT NOT NULL DEFAULT 'ja-JP',
  timezone         TEXT NOT NULL DEFAULT 'Asia/Tokyo'
);

-- ── 端末登録(子供にアカウントを持たせないための仕組み) ──

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  label        TEXT NOT NULL,          -- 「リビングのiPad」
  kind         TEXT NOT NULL CHECK (kind IN ('shared', 'child', 'parent')),
  member_id    TEXT REFERENCES members (id),  -- kind='child' のとき固定される子
  token_hash   TEXT NOT NULL UNIQUE,
  skip_pin     INTEGER NOT NULL DEFAULT 0,    -- kind='parent' のみ許可
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX devices_family ON devices (family_id);

-- 招待リンク(短命・使い捨て)
CREATE TABLE device_invites (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families (id),
  token_hash TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('shared', 'child', 'parent')),
  member_id  TEXT REFERENCES members (id),
  label      TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  device_id  TEXT REFERENCES devices (id)
);
CREATE INDEX device_invites_family ON device_invites (family_id, created_at);

-- ── お手伝いメニュー(自由入力で自己増殖する家族共通マスター) ──

CREATE TABLE chores (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families (id),
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,          -- 正規化キー(表記ゆれのマージ用)
  emoji         TEXT,
  default_count INTEGER NOT NULL DEFAULT 1,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_by    TEXT REFERENCES members (id),
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE UNIQUE INDEX chores_family_norm ON chores (family_id, name_norm);
CREATE INDEX chores_family_order ON chores (family_id, archived_at, use_count DESC);

-- ── 台帳 ───────────────────────────────────────

CREATE TABLE sheets (
  id                  TEXT PRIMARY KEY,
  family_id           TEXT NOT NULL REFERENCES families (id),
  member_id           TEXT NOT NULL REFERENCES members (id),
  seq_no              INTEGER NOT NULL,   -- その子の何冊目か
  capacity            INTEGER NOT NULL,   -- 発行時点の family_settings.capacity を固定
  status              TEXT NOT NULL CHECK (status IN ('active', 'full', 'redeemed')),
  version             INTEGER NOT NULL DEFAULT 0,   -- 楽観ロック
  started_at          INTEGER NOT NULL,
  filled_at           INTEGER,
  redeem_requested_at INTEGER,            -- 子が「こうかんしたい」を押した時刻
  redeemed_at         INTEGER
);
CREATE UNIQUE INDEX sheets_member_seq ON sheets (member_id, seq_no);
-- 1人につき active な台帳は同時に1冊しか存在しえない、をDBで保証する
CREATE UNIQUE INDEX sheets_one_active ON sheets (member_id) WHERE status = 'active';
CREATE INDEX sheets_family_member ON sheets (family_id, member_id, seq_no DESC);

-- お手伝い1回の記録。シールを n 枚発行する単位であり、取り消しの単位でもある
CREATE TABLE grants (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families (id),
  member_id     TEXT NOT NULL REFERENCES members (id),
  chore_id      TEXT REFERENCES chores (id),
  chore_label   TEXT NOT NULL,          -- 記録時点の名前を凍結する
  chore_emoji   TEXT,
  count         INTEGER NOT NULL CHECK (count > 0),
  note          TEXT,
  created_by    TEXT NOT NULL REFERENCES members (id),
  created_via   TEXT NOT NULL CHECK (created_via IN ('self', 'parent')),
  request_id    TEXT NOT NULL,          -- 連打による二重送信を握りつぶす
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,                -- require_approval=0 なら created_at と同時にセット
  approved_by   TEXT REFERENCES members (id),
  revoked_at    INTEGER,
  revoked_by    TEXT REFERENCES members (id),
  revoke_reason TEXT
);
CREATE UNIQUE INDEX grants_request_id ON grants (request_id);
CREATE INDEX grants_family_member ON grants (family_id, member_id, created_at DESC);
CREATE INDEX grants_pending ON grants (family_id, approved_at) WHERE approved_at IS NULL AND revoked_at IS NULL;

-- 台帳のマス1つ。台帳をまたいだ付与は、同じ grant から複数の sheet に散る
CREATE TABLE stickers (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families (id),
  grant_id   TEXT NOT NULL REFERENCES grants (id),
  sheet_id   TEXT NOT NULL REFERENCES sheets (id),
  position   INTEGER NOT NULL,          -- 1..capacity
  art        TEXT,                      -- シールの絵柄
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- 有効なシールだけがマスを占有する。取り消すと穴が空き、次のシールがそこを埋める
CREATE UNIQUE INDEX stickers_slot ON stickers (sheet_id, position) WHERE revoked_at IS NULL;
CREATE INDEX stickers_sheet ON stickers (sheet_id);
CREATE INDEX stickers_grant ON stickers (grant_id);

-- ── 交換 ───────────────────────────────────────

CREATE TABLE redemptions (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families (id),
  sheet_id     TEXT NOT NULL UNIQUE REFERENCES sheets (id),
  member_id    TEXT NOT NULL REFERENCES members (id),
  reward_text  TEXT NOT NULL,           -- 「Robux 1200」「鬼滅の刃 20巻」
  category     TEXT,                    -- roblox / minecraft / book / game / other
  amount_yen   INTEGER,                 -- 任意
  requested_at INTEGER,
  approved_by  TEXT NOT NULL REFERENCES members (id),
  approved_at  INTEGER NOT NULL
);
CREATE INDEX redemptions_family_member ON redemptions (family_id, member_id, approved_at DESC);
