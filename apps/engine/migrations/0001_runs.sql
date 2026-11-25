-- The index of runs (decision 0004): one row per run. The run's log, in its own Durable Object,
-- stays the source of truth; this says that a run started, how it ended and where its archive is.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  -- 'Running', or the tag of the final state.
  state TEXT NOT NULL,
  -- Milliseconds since the epoch, as in the events.
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- The key of the run's log in the archive bucket, once it has ended.
  archive_key TEXT,
  -- What a record block wrote, as JSON: for a restore drill, the rows compared and the checksum.
  result TEXT
);

CREATE INDEX runs_by_start ON runs (started_at DESC);
