ALTER TABLE rooms ADD COLUMN track_time_limit_minutes INTEGER NOT NULL DEFAULT 10
  CHECK (typeof(track_time_limit_minutes) = 'integer' AND track_time_limit_minutes BETWEEN 0 AND 9007199254740991);
