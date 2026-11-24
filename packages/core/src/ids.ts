import { Schema } from "effect";

// Every pattern carries the `u` flag: without it `isPattern` is dropped from the generated
// JSON Schema (M1 Part A findings). `require-unicode-regexp` enforces this.

const maxIdLength = 64;

/** `export`, `createTemp`: a camel-case word. */
const camelCase = /^[a-z][a-zA-Z0-9]*$/u;
/** `d1.exportDatabase`, `cloudflare.d1.database`: two or more camel-case words joined by dots. */
const dotted = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/u;
/** `restore-drill`: lower-case words joined by hyphens. */
const kebabCase = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const idString = (pattern: RegExp) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(pattern), Schema.isMaxLength(maxIdLength)));

/** A step's id, unique within its recipe. */
export const StepId = idString(camelCase).pipe(
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("StepId"),
  Schema.annotate({ identifier: "StepId" }),
);
export type StepId = typeof StepId.Type;

/** The name of a recipe input, a block input or a block output. */
export const Name = idString(camelCase).pipe(
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("Name"),
  Schema.annotate({ identifier: "Name" }),
);
export type Name = typeof Name.Type;

/** A block's id, such as `d1.exportDatabase`. */
export const BlockId = idString(dotted).pipe(
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("BlockId"),
  Schema.annotate({ identifier: "BlockId" }),
);
export type BlockId = typeof BlockId.Type;

/** The kind of thing a `Resource` refers to, such as `cloudflare.d1.database`. */
export const ResourceKind = idString(dotted).pipe(
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("ResourceKind"),
  Schema.annotate({ identifier: "ResourceKind" }),
);
export type ResourceKind = typeof ResourceKind.Type;

/** A recipe's id, such as `restore-drill`. */
export const RecipeId = idString(kebabCase).pipe(
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("RecipeId"),
  Schema.annotate({ identifier: "RecipeId" }),
);
export type RecipeId = typeof RecipeId.Type;

/** A run's id, chosen by the engine when the run starts. Letters, digits, `-` and `_`. */
export const RunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u), Schema.isMaxLength(maxIdLength)),
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("RunId"),
  Schema.annotate({ identifier: "RunId" }),
);
export type RunId = typeof RunId.Type;

/** The version of a block or a recipe: 1, 2, 3, … */
export const Version = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("Version"),
  Schema.annotate({ identifier: "Version" }),
);
export type Version = typeof Version.Type;

/** Text a person reads: a title, a description, a reason. Never empty, and never only spaces. */
export const Prose = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/u), Schema.isMaxLength(2000)),
  Schema.annotate({ identifier: "Prose" }),
);

/** The entries of a record keyed by `Name`, with their keys still typed as names. */
export const namesOf = <A>(record: { readonly [name: Name]: A }): ReadonlyArray<[Name, A]> =>
  // `Object.entries` widens keys to `string`; every key of such a record was decoded as a `Name`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Object.entries(record) as Array<[Name, A]>;

/** The value a record holds under a name of its own, never an inherited property such as `toString`. */
export const own = <A>(record: { readonly [name: string]: A }, name: string): A | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;
