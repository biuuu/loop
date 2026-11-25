ALTER TABLE rooms ADD COLUMN stage_time_limit_minutes INTEGER NOT NULL DEFAULT 120
  CHECK (typeof(stage_time_limit_minutes) = 'integer' AND stage_time_limit_minutes BETWEEN 0 AND 720);
