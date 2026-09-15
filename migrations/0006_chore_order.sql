-- お手伝いメニューの並び順を、親が決められるようにする。
--
-- これまでは使用頻度で自動的に並んでいた(use_count DESC)。よく押すものほど上に
-- 上がっていくので、子どもから見るとボタンの位置が日によって変わる。
-- 親が決めた順に固定して、毎回同じ位置に同じボタンがあるようにする。
--
-- use_count は数え続ける。親設定の一覧に「N回」として出ていて、参考になるため。

ALTER TABLE chores ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- 今の並び(使用頻度順)を、そのまま初期値にする。
--
-- ORDER BY は、これまでの listChores と一字一句同じにしておくこと。ずれると、
-- デプロイした瞬間にお子さんの画面でボタンの並びが変わってしまう。
-- 末尾の id は、名前まで同じだった場合に採番を決定的にするためだけのもの。
--
-- アーカイブ済みの行も採番する。0 のまま残すと、アーカイブを戻したときに
-- 意図しない位置へ出てくる(戻したときは一番上へ移すが、念のため)。
UPDATE chores SET sort_order = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY family_id
             ORDER BY use_count DESC, last_used_at DESC, name, id
           ) AS rn
      FROM chores
  ) ranked
  WHERE ranked.id = chores.id
);

-- (family_id, sort_order) にユニーク制約は付けない。
-- 並べ替えでは全体を振り直すが、SQLite は文ごとに制約を確かめるので、
-- 振り直しの途中で一時的に同じ値が2行に出て落ちてしまう。
-- 表示は ORDER BY sort_order, name なので、万一重複しても順は決まる。
CREATE INDEX chores_family_sort ON chores (family_id, archived_at, sort_order);
