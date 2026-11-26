CREATE TABLE points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  reference TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  UNIQUE (guest_id, source, reference)
);

CREATE TABLE coat_unlocks (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL CHECK (pattern IN ('calico', 'cow', 'orange_white', 'tortoiseshell', 'seal_point', 'tabby_white')),
  PRIMARY KEY (guest_id, pattern)
);

CREATE TABLE daily_dj_time (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  played_ms INTEGER NOT NULL CHECK (played_ms > 0),
  credited_through_ms INTEGER NOT NULL,
  PRIMARY KEY (guest_id, date)
);

INSERT INTO points_ledger (guest_id, source, reference, delta)
SELECT id, 'initial', 'account', 5 FROM guests;

INSERT INTO coat_unlocks (guest_id, pattern)
SELECT id, pattern FROM guests
WHERE pattern IN ('calico', 'cow', 'orange_white', 'tortoiseshell', 'seal_point', 'tabby_white');
