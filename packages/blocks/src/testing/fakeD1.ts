import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Option, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql";
import type { D1Database, D1FailureReason, D1Row } from "../services";
import { D1Api, D1Failed } from "../services";

// A fake of Cloudflare's D1 API for the blocks' tests (M2 Part D, D1): each database is a SQLite
// database in memory, so the figures' SQL runs for real. A test can make the next calls of an
// operation fail, write to a database just before it is exported, lose the answer to a create,
// and let an export's link expire; and it can count what each operation did.

type Operation =
  | "query"
  | "exportDatabase"
  | "importExport"
  | "create"
  | "get"
  | "findByName"
  | "delete";

type Stored = {
  readonly name: string;
  readonly sql: SqlClient.SqlClient;
};

/** What the fake did, for a test to look at. */
export type FakeD1 = {
  readonly api: D1Api["Service"];
  /** Makes a database as Cloudflare would, holding what `statements` make. */
  readonly seed: (name: string, statements: ReadonlyArray<string>) => Effect.Effect<D1Database>;
  /** Runs statements on a database, as someone else writing to it would. */
  readonly write: (id: string, statements: ReadonlyArray<string>) => Effect.Effect<void>;
  /** The next `times` calls of `operation` fail as `reason`, doing nothing. */
  readonly failNext: (operation: Operation, reason: D1FailureReason, times?: number) => void;
  /** Runs once, inside the next export, before the database is read: a write lands there. */
  readonly beforeNextExport: (effect: Effect.Effect<void>) => void;
  /** Runs once, inside the next create, before it looks for the name: another attempt lands there. */
  readonly beforeNextCreate: (effect: Effect.Effect<void>) => void;
  /** The next create makes its database and then answers `Unavailable`. */
  readonly loseNextCreateAnswer: () => void;
  /** Every export link made so far stops working. */
  readonly expireExports: () => void;
  readonly databases: () => ReadonlyArray<D1Database>;
  /** How many times each operation changed something: databases made, deleted, imports done. */
  readonly effects: { created: number; deleted: number; imported: number; exported: number };
};

const run = (
  sql: SqlClient.SqlClient,
  statement: string,
  params: ReadonlyArray<string | number> = [],
) => Effect.orDie(sql.unsafe<D1Row>(statement, params));

/** What D1's export holds: each table's schema, then its rows as INSERT statements. */
const dump = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* run(
      sql,
      String.raw`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`,
    );
    const statements: Array<string> = [];
    for (const table of tables) {
      const name = String(table["name"]);
      statements.push(String(table["sql"]));
      const columns = yield* run(sql, `PRAGMA table_info("${name}")`);
      const values = columns
        .map((column) => `quote("${String(column["name"])}")`)
        .join(" || ',' || ");
      const rows = yield* run(
        sql,
        `SELECT 'INSERT INTO "${name}" VALUES(' || ${values} || ')' AS s FROM "${name}"`,
      );
      statements.push(...rows.map((row) => String(row["s"])));
    }
    return statements;
  });

const failure = (operation: string, reason: D1FailureReason) =>
  new D1Failed({ reason, operation, message: `The fake says ${reason}.` });

/** A fake D1 API, its databases gone when the scope closes. */
export const makeFakeD1: Effect.Effect<FakeD1, never, Scope.Scope> = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const stored = new Map<string, Stored>();
  const exports = new Map<
    string,
    { readonly statements: ReadonlyArray<string>; expired: boolean }
  >();
  const faults = new Map<Operation, Array<D1FailureReason>>();
  let beforeExport: Effect.Effect<void> | undefined;
  let beforeCreate: Effect.Effect<void> | undefined;
  let loseCreate = false;
  let made = 0;
  const effects = { created: 0, deleted: 0, imported: 0, exported: 0 };

  const open = SqliteClient.make({ filename: ":memory:" }).pipe(
    Effect.provide(Reactivity.layer),
    Scope.provide(scope),
    Effect.orDie,
  );

  const faulted = (operation: Operation) =>
    Effect.suspend(() => {
      const reason = faults.get(operation)?.shift();
      return reason === undefined ? Effect.void : Effect.fail(failure(operation, reason));
    });

  const find = (operation: string, id: string) =>
    Effect.suspend(() => {
      const found = stored.get(id);
      return found === undefined
        ? Effect.fail(failure(operation, "NotFound"))
        : Effect.succeed(found);
    });

  const makeDatabase = (name: string) =>
    Effect.gen(function* () {
      made += 1;
      const id = `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`;
      stored.set(id, { name, sql: yield* open });
      effects.created += 1;
      return { id, name };
    });

  const api = D1Api.of({
    query: (id, statement, params) =>
      Effect.gen(function* () {
        yield* faulted("query");
        const { sql } = yield* find("query", id);
        // As at Cloudflare, a statement SQLite refuses is a refused request.
        return yield* sql
          .unsafe<D1Row>(statement, params)
          .pipe(
            Effect.mapError(
              (error) =>
                new D1Failed({ reason: "Refused", operation: "query", message: error.message }),
            ),
          );
      }),
    exportDatabase: (id) =>
      Effect.gen(function* () {
        yield* faulted("exportDatabase");
        const { sql } = yield* find("exportDatabase", id);
        const hook = beforeExport;
        beforeExport = undefined;
        if (hook !== undefined) {
          yield* hook;
        }
        const statements = yield* dump(sql);
        const url = `https://d1-exports.invalid/${id}/${exports.size + 1}.sql`;
        exports.set(url, { statements, expired: false });
        effects.exported += 1;
        return { url };
      }),
    importExport: (id, url) =>
      Effect.gen(function* () {
        yield* faulted("importExport");
        const target = yield* find("importExport", id);
        const file = exports.get(url);
        if (file === undefined || file.expired) {
          return yield* failure("importExport", "ExportExpired");
        }
        // As at Cloudflare, the same file again is imported again: its CREATE TABLE then fails.
        for (const statement of file.statements) {
          yield* target.sql.unsafe(statement).pipe(
            Effect.mapError(
              () =>
                new D1Failed({
                  reason: "Failed",
                  operation: "importExport",
                  message: `The import failed on: ${statement.slice(0, 60)}`,
                }),
            ),
          );
        }
        effects.imported += 1;
      }),
    create: (name) =>
      Effect.gen(function* () {
        yield* faulted("create");
        const hook = beforeCreate;
        beforeCreate = undefined;
        if (hook !== undefined) {
          yield* hook;
        }
        if ([...stored.values()].some((each) => each.name === name)) {
          return yield* failure("create", "AlreadyExists");
        }
        const database = yield* makeDatabase(name);
        if (loseCreate) {
          loseCreate = false;
          return yield* failure("create", "Unavailable");
        }
        return database;
      }),
    get: (id) =>
      Effect.gen(function* () {
        yield* faulted("get");
        const found = stored.get(id);
        return found === undefined ? Option.none() : Option.some({ id, name: found.name });
      }),
    findByName: (name) =>
      Effect.gen(function* () {
        yield* faulted("findByName");
        const found = [...stored.entries()].find(([, each]) => each.name === name);
        return found === undefined ? Option.none() : Option.some({ id: found[0], name });
      }),
    delete: (id) =>
      Effect.gen(function* () {
        yield* faulted("delete");
        if (stored.delete(id)) {
          effects.deleted += 1;
        }
      }),
  });

  return {
    api,
    seed: (name, statements) =>
      Effect.gen(function* () {
        const database = yield* makeDatabase(name);
        effects.created -= 1;
        const { sql } = yield* Effect.orDie(find("seed", database.id));
        for (const statement of statements) {
          yield* run(sql, statement);
        }
        return database;
      }),
    write: (id, statements) =>
      Effect.gen(function* () {
        const { sql } = yield* Effect.orDie(find("write", id));
        for (const statement of statements) {
          yield* run(sql, statement);
        }
      }),
    failNext: (operation, reason, times = 1) => {
      faults.set(operation, [
        ...(faults.get(operation) ?? []),
        ...Array.from({ length: times }, () => reason),
      ]);
    },
    beforeNextExport: (effect) => {
      beforeExport = effect;
    },
    beforeNextCreate: (effect) => {
      beforeCreate = effect;
    },
    loseNextCreateAnswer: () => {
      loseCreate = true;
    },
    expireExports: () => {
      for (const file of exports.values()) {
        file.expired = true;
      }
    },
    databases: () => [...stored.entries()].map(([id, each]) => ({ id, name: each.name })),
    effects,
  };
});

/** The fake as the `D1Api` layer, for a test that only needs the service. */
export const fakeD1Layer = (fake: FakeD1): Layer.Layer<D1Api> => Layer.succeed(D1Api, fake.api);
