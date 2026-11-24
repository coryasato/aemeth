import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { idempotencyKey, IdempotencyKey, ItemIndex, RunId, StepId } from "../index";

const strict = { onExcessProperty: "error" } as const;
const run = Schema.decodeUnknownSync(RunId);
const step = Schema.decodeUnknownSync(StepId);
const accepts = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema, strict)(value));

/** One piece of work: a step or its undo, for one item or for none. */
const Work = Schema.Struct({
  runId: RunId,
  step: StepId,
  phase: Schema.Literals(["Forward", "Undo"]),
  item: Schema.UndefinedOr(ItemIndex),
});
const keyOf = ({ item, phase, runId, step: id }: typeof Work.Type) =>
  idempotencyKey(runId, id, phase, item);

describe("idempotencyKey", () => {
  it("is the run, the step and the phase, and the item of a for-each", () => {
    expect(idempotencyKey(run("run-1"), step("export"), "Forward", undefined)).toBe(
      "run-1:export:Forward",
    );
    expect(idempotencyKey(run("run-1"), step("export"), "Undo", undefined)).toBe(
      "run-1:export:Undo",
    );
    expect(idempotencyKey(run("run-1"), step("deploy"), "Forward", 0)).toBe(
      "run-1:deploy:Forward:0",
    );
    expect(idempotencyKey(run("run_2"), step("deploy"), "Undo", 12)).toBe("run_2:deploy:Undo:12");
  });

  const seen = { same: 0, different: 0, items: 0, undo: 0 };

  it.prop(
    "is the same for the same work and different for any other, and fits its Schema",
    [Work, Work, Schema.Boolean],
    ([first, other, takeFirst]) => {
      // Two generated pieces of work are almost never the same, so half the time the second is
      // the first again, built afresh.
      const second = takeFirst ? { ...first } : other;
      const same =
        first.runId === second.runId &&
        first.step === second.step &&
        first.phase === second.phase &&
        first.item === second.item;
      expect(keyOf(first) === keyOf(second)).toBe(same);
      expect(accepts(IdempotencyKey, keyOf(first))).toBe(true);
      // A step's undo never shares its key.
      expect(keyOf({ ...first, phase: "Undo" })).not.toBe(keyOf({ ...first, phase: "Forward" }));
      seen.same += same ? 1 : 0;
      seen.different += same ? 0 : 1;
      seen.items += first.item === undefined ? 0 : 1;
      seen.undo += first.phase === "Undo" ? 1 : 0;
    },
    { arbitrary: { runs: 500 } },
  );

  it("reached the same work and other work, items and undos", () => {
    expect(seen.same).toBeGreaterThan(50);
    expect(seen.different).toBeGreaterThan(50);
    expect(seen.items).toBeGreaterThan(50);
    expect(seen.undo).toBeGreaterThan(50);
  });
});

describe("IdempotencyKey", () => {
  it.each([
    "run1:a:Forward",
    "run-1:exportDb:Undo",
    "r_1:a:Forward:0",
    "r:a:Undo:120",
    "r:a:Undo:999999",
    "r:a:Undo:1000000",
    `${"r".repeat(64)}:a:Undo`,
    `r:${"a".repeat(64)}:Undo`,
    `${"r".repeat(64)}:${"a".repeat(64)}:Forward:1000000`,
  ])("accepts %j", (value) => {
    expect(accepts(IdempotencyKey, value)).toBe(true);
  });
  it.each([
    "",
    "run1:a",
    "run1:a:Finally",
    "run1:a:forward",
    "run1:A:Forward",
    ":a:Forward",
    "run1::Forward",
    "run 1:a:Forward",
    "run1:a:Forward:",
    "run1:a:Forward:01",
    "run1:a:Forward:-1",
    "run1:a:Forward:1:2",
    "x:run1:a:Forward",
    "run1:a:Forward ",
    `${"r".repeat(65)}:${"a".repeat(64)}:Forward:1000000`,
    `${"r".repeat(64)}:${"a".repeat(65)}:Forward`,
    `${"r".repeat(120)}:s:Undo`,
    "r:s:Undo:1000001",
    "r:s:Undo:9999999",
    "r:s:Undo:99999999999",
    1,
  ])("rejects %j", (value) => {
    expect(accepts(IdempotencyKey, value)).toBe(false);
  });
});

describe("RunId", () => {
  it.each(["a", "run1", "Run-1_b", "0", "a".repeat(64)])("accepts %j", (value) => {
    expect(accepts(RunId, value)).toBe(true);
  });
  it.each(["", "-a", "_a", "a b", "a:b", "a.b", "a/b", "é", "a".repeat(65), 1])(
    "rejects %j",
    (value) => {
      expect(accepts(RunId, value)).toBe(false);
    },
  );
});

describe("ItemIndex", () => {
  it.each([0, 1, 1_000_000])("accepts %j", (value) => {
    expect(accepts(ItemIndex, value)).toBe(true);
  });
  it.each([-1, 0.5, 1_000_001, "0"])("rejects %j", (value) => {
    expect(accepts(ItemIndex, value)).toBe(false);
  });
});
