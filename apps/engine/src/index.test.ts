import { BlockId, Version } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { announceBlock } from "./index";

describe("announceBlock", () => {
  it.effect("returns the block's title", () =>
    Effect.gen(function* () {
      const id = yield* Schema.decodeEffect(BlockId)("d1.exportDatabase");
      const version = yield* Schema.decodeEffect(Version)(1);
      expect(yield* announceBlock(id, version)).toBe("Export a database");
    }),
  );

  it.effect("says when a block is not declared at that version", () =>
    Effect.gen(function* () {
      const id = yield* Schema.decodeEffect(BlockId)("d1.exportDatabase");
      const version = yield* Schema.decodeEffect(Version)(2);
      expect(yield* announceBlock(id, version)).toBe("unknown block d1.exportDatabase@2");
    }),
  );
});
