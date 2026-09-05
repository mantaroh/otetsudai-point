-- Web Push の購読。
--
-- 端末ごとに1つ。endpoint が購読の identity なので、そこに一意制約を置く。
-- 失効した購読(404/410)は削除せず revoked_at で無効化する。

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

-- 同じ家庭・同じ日・同じ種類の通知は1回しか送らない。
-- 親が ON した瞬間の送信と、朝の Cron の送信がぶつかるのを、
-- アプリ側の条件分岐ではなく主キーで止める。
CREATE TABLE push_sends (
  family_id TEXT NOT NULL REFERENCES families (id),
  day_key   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (family_id, day_key, kind)
);
