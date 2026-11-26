-- Replace the inline pattern check while preserving foreign-key references to guests.
ALTER TABLE guests RENAME COLUMN pattern TO previous_pattern;
ALTER TABLE guests ADD COLUMN pattern TEXT NOT NULL DEFAULT 'solid'
  CHECK (
    pattern IN ('solid', 'socks', 'tabby')
    OR (pattern IN ('calico', 'cow', 'orange_white') AND coat = 'white')
    OR (pattern = 'tortoiseshell' AND coat = 'black')
    OR (pattern = 'seal_point' AND coat = 'cream')
    OR (pattern = 'tabby_white' AND coat = 'gray')
  );
UPDATE guests SET pattern = CASE previous_pattern
  WHEN 'silver_shaded' THEN 'solid'
  ELSE previous_pattern
END;
ALTER TABLE guests DROP COLUMN previous_pattern;
