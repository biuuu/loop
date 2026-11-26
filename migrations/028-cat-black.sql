CREATE TABLE coat_unlocks_new (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL CHECK (pattern IN ('calico', 'cow', 'orange_white', 'seal_point', 'tabby_white', 'ragdoll', 'black_cat')),
  PRIMARY KEY (guest_id, pattern)
);

-- Carry over tortoiseshell unlocks and grant the new preset to cats wearing pure black.
INSERT INTO coat_unlocks_new (guest_id, pattern)
SELECT guest_id, CASE pattern WHEN 'tortoiseshell' THEN 'black_cat' ELSE pattern END
FROM coat_unlocks
UNION
SELECT id, 'black_cat' FROM guests WHERE coat = 'pure_black';

DROP TABLE coat_unlocks;
ALTER TABLE coat_unlocks_new RENAME TO coat_unlocks;

-- Replace both appearance checks in place to preserve references to guests.
ALTER TABLE guests RENAME COLUMN coat TO previous_coat;
ALTER TABLE guests RENAME COLUMN pattern TO previous_pattern;
ALTER TABLE guests ADD COLUMN coat TEXT NOT NULL DEFAULT 'orange'
  CHECK (coat IN ('orange', 'gray', 'cream', 'black', 'white', 'pure_white'));
ALTER TABLE guests ADD COLUMN pattern TEXT NOT NULL DEFAULT 'solid'
  CHECK (
    pattern IN ('solid', 'socks', 'tabby')
    OR (pattern IN ('calico', 'cow', 'orange_white', 'ragdoll') AND coat = 'white')
    OR (pattern = 'seal_point' AND coat = 'cream')
    OR (pattern = 'tabby_white' AND coat = 'gray')
    OR (pattern = 'black_cat' AND coat = 'black')
  );
UPDATE guests SET
  coat = CASE previous_coat WHEN 'pure_black' THEN 'black' ELSE previous_coat END,
  pattern = CASE
    WHEN previous_coat = 'pure_black' THEN 'black_cat'
    WHEN previous_pattern = 'tortoiseshell' THEN 'solid'
    ELSE previous_pattern
  END;
ALTER TABLE guests DROP COLUMN previous_pattern;
ALTER TABLE guests DROP COLUMN previous_coat;
