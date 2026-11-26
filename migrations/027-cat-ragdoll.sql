-- Replace the pattern check while preserving foreign-key references to guests.
ALTER TABLE guests RENAME COLUMN pattern TO previous_pattern;
ALTER TABLE guests ADD COLUMN pattern TEXT NOT NULL DEFAULT 'solid'
  CHECK (
    pattern IN ('solid', 'socks', 'tabby')
    OR (pattern IN ('calico', 'cow', 'orange_white', 'ragdoll') AND coat = 'white')
    OR (pattern = 'tortoiseshell' AND coat = 'black')
    OR (pattern = 'seal_point' AND coat = 'cream')
    OR (pattern = 'tabby_white' AND coat = 'gray')
  );
UPDATE guests SET pattern = previous_pattern;
ALTER TABLE guests DROP COLUMN previous_pattern;

CREATE TABLE coat_unlocks_new (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL CHECK (pattern IN ('calico', 'cow', 'orange_white', 'tortoiseshell', 'seal_point', 'tabby_white', 'ragdoll')),
  PRIMARY KEY (guest_id, pattern)
);
INSERT INTO coat_unlocks_new (guest_id, pattern)
SELECT guest_id, pattern FROM coat_unlocks;
DROP TABLE coat_unlocks;
ALTER TABLE coat_unlocks_new RENAME TO coat_unlocks;
