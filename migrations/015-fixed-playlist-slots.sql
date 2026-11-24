ALTER TABLE guests ADD COLUMN active_playlist_slot INTEGER NOT NULL DEFAULT 1
  CHECK (active_playlist_slot IN (1, 2, 3));

UPDATE guests SET active_playlist_slot=playlist_slot WHERE playlist_slot<>1;

ALTER TABLE guests DROP COLUMN playlist_slot;
ALTER TABLE guests DROP COLUMN playlist_count;
