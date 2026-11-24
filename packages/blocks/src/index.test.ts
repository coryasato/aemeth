import { blockSpecProblems } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import { blockSpecs, declarations } from "./index";

describe("block declarations", () => {
  const specs = Result.getOrThrow(blockSpecs);

  it("all decode as a BlockSpec", () => {
    expect(specs).toHaveLength(declarations.length);
    expect(specs).toEqual(declarations);
  });

  it("each have a unique id and version", () => {
    const keys = specs.map((spec) => `${spec.id}@${spec.version}`);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it("are grouped by target", () => {
    const groups = new Set(specs.map((spec) => spec.id.split(".")[0]));
    expect([...groups]).toEqual([
      "d1",
      "alchemy",
      "workers",
      "secrets",
      "artifacts",
      "gate",
      "record",
    ]);
  });

  it.each(Result.getOrThrow(blockSpecs))("$id is consistent with itself", (spec) => {
    expect(blockSpecProblems(spec)).toEqual([]);
  });

  it("name an undo block that is declared, at that version", () => {
    const keys = new Set(specs.map((spec) => `${spec.id}@${spec.version}`));
    const missing = specs.flatMap((spec) =>
      spec.undo._tag === "Undo" && !keys.has(`${spec.undo.block}@${spec.undo.version}`)
        ? [`${spec.id} -> ${spec.undo.block}@${spec.undo.version}`]
        : [],
    );
    expect(missing).toEqual([]);
  });

  it("give every gate the Gate kind and no effects", () => {
    const gates = specs.filter((spec) => spec.id.startsWith("gate."));
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((spec) => spec.kind === "Gate" && spec.effects.length === 0)).toBe(true);
    expect(specs.filter((spec) => spec.kind === "Gate")).toEqual(gates);
  });
});
