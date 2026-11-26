-- The seeded sample database a stage that is thrown away carries (M2 Part D, D2): what the
-- restore drill exports, restores and checks on such a stage. It is small, and still has what
-- the figures must get right: more rows than one page of 500, a key of two columns, a table
-- keyed by text, every kind of value SQLite stores, a NULL, quotes and text that is not ASCII.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  credit REAL,
  avatar BLOB,
  note
);

CREATE TABLE orders (
  customer INTEGER NOT NULL REFERENCES customers (id),
  number INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  placed_at TEXT NOT NULL,
  PRIMARY KEY (customer, number)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
INSERT INTO customers (id, name, email, credit, avatar, note)
SELECT
  i,
  'Customer ' || i,
  'customer' || i || '@example.com',
  CASE WHEN i % 7 = 0 THEN NULL ELSE i * 1.25 END,
  CASE WHEN i % 50 = 0 THEN x'00ff10' ELSE NULL END,
  CASE i % 4 WHEN 0 THEN NULL WHEN 1 THEN 'it''s ' || i WHEN 2 THEN i ELSE 'café ✓' END
FROM n;

WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 800)
INSERT INTO orders (customer, number, total_cents, placed_at)
SELECT
  (i % 400) + 1,
  i,
  (i * 37) % 10000,
  '2026-11-' || printf('%02d', (i % 28) + 1) || 'T12:00:00Z'
FROM n;

INSERT INTO settings (key, value) VALUES
  ('currency', 'EUR'),
  ('locale', 'fr-FR'),
  ('quoted', '"double" and ''single'''),
  ('empty', ''),
  ('none', NULL);
