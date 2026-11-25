// Helpers for tests in this repository's other packages: builders for blocks and recipes, and
// the scripted player of `decide`. Not part of what the engine or the UI imports.
//
// A helper here may throw (CLAUDE.md, "Failures are states, not exceptions"): a builder given a
// document that does not decode, or a recipe that does not resolve, should fail the test that
// wrote it, there and then.
export * from "./build";
export { generatedCatalog } from "./generate";
export * from "./play";
