ALTER TABLE guests ADD COLUMN playlist_count INTEGER NOT NULL DEFAULT 1
  CHECK (playlist_count IN (1, 2, 3));
ALTER TABLE guests ADD COLUMN playlist_slot INTEGER NOT NULL DEFAULT 1
  CHECK (playlist_slot IN (1, 2, 3) AND playlist_slot <= playlist_count);

CREATE TABLE playlists_with_slots (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_json TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 1 CHECK (slot IN (1, 2, 3)),
  PRIMARY KEY (guest_id, slot, track_id)
);

INSERT INTO playlists_with_slots (guest_id, track_id, position, track_json)
SELECT guest_id, track_id, position, track_json FROM playlist;

DROP TABLE playlist;
ALTER TABLE playlists_with_slots RENAME TO playlist;
