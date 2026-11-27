ALTER TABLE guests ADD COLUMN accessories_json TEXT CHECK (
  accessories_json IS NULL
  OR (json_valid(accessories_json) AND json_type(accessories_json) = 'object')
);

CREATE TABLE accessory_unlocks (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  accessory_id TEXT NOT NULL,
  PRIMARY KEY (guest_id, accessory_id)
);
