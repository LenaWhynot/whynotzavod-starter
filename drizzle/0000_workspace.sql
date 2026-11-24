CREATE TABLE workspace_snapshots (
  name TEXT PRIMARY KEY,
  document TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE workspace_edits (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
