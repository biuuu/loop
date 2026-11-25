-- Replace the inline pattern check while preserving foreign-key references to guests.
ALTER TABLE guests RENAME COLUMN pattern TO previous_pattern;
ALTER TABLE guests ADD COLUMN pattern TEXT NOT NULL DEFAULT 'solid'
  CHECK (
    pattern IN ('solid', 'socks', 'tabby')
    OR (pattern IN ('calico', 'cow', 'orange_white') AND coat = 'white')
    OR (pattern = 'tortoiseshell' AND coat = 'black')
  );
UPDATE guests SET pattern = previous_pattern;
ALTER TABLE guests DROP COLUMN previous_pattern;
