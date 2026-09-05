-- ポイント2倍デー。
--
-- 単発（今日だけ）も定期（毎週日曜・毎月9日）も、このテーブルの1行として持つ。
-- 削除はせず disabled_at で無効化する（既存テーブルの方針に合わせる）。

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

-- 同じ内容のルールが二重に登録されないようにする(有効なものだけ)。
-- アプリ側の約束ではなく、スキーマ側の制約として持たせる。
CREATE UNIQUE INDEX bonus_rules_once
  ON bonus_rules (family_id, on_date)      WHERE kind = 'once'    AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_weekly
  ON bonus_rules (family_id, weekday)      WHERE kind = 'weekly'  AND disabled_at IS NULL;
CREATE UNIQUE INDEX bonus_rules_monthly
  ON bonus_rules (family_id, day_of_month) WHERE kind = 'monthly' AND disabled_at IS NULL;

-- 倍にする前の枚数と、適用した倍率。
-- count は今まで通り「実際に貼られたシールの枚数」＝倍したあとの値のまま。
ALTER TABLE grants ADD COLUMN base_count INTEGER;
ALTER TABLE grants ADD COLUMN multiplier INTEGER NOT NULL DEFAULT 1;
