// Guards packages/core/src/invariants/ (spec decision 7 in docs/milestones/m0.md, as changed in
// M0 Part C). Adding an invariant is allowed; changing or removing one needs the owner's explicit
// approval (CLAUDE.md, hard rule 1).
//
// - Edit, MultiEdit, Write, NotebookEdit: before the call, ask the person when the target file is
//   in the folder. The path is exact, so other files never prompt.
// - Bash: a command's text cannot say reliably whether it writes, so nothing is asked up front.
//   Before the command the folder's contents are fingerprinted; after it they are compared, and
//   any change is reported to Claude and the person. Reads and mere mentions never prompt.
import { Schema } from "effect";
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const projectDir = resolve(import.meta.dir, "../..");
const invariantsDir = join(projectDir, "packages/core/src/invariants");
const invariantsPath = "packages/core/src/invariants/";

const HookInput = Schema.Struct({
  hook_event_name: Schema.String,
  session_id: Schema.String,
  tool_name: Schema.String,
  tool_use_id: Schema.optional(Schema.String),
  tool_input: Schema.Record(Schema.String, Schema.Unknown),
});
type HookInput = typeof HookInput.Type;

const approvalReason =
  "This touches packages/core/src/invariants/, which the owner writes. Adding an invariant is allowed; changing or removing one needs the owner's explicit approval (CLAUDE.md, hard rule 1).";

const ask = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: reason,
  },
});

const report = (finding: string) => {
  const reason = `${finding} Stop and get the owner's explicit approval for this change, or undo it (CLAUDE.md, hard rule 1). Adding a new invariant is allowed.`;
  return { decision: "block", reason, systemMessage: reason };
};

// One entry per file: its path inside the folder and a hash of its contents.
const fingerprint = async (): Promise<Record<string, string>> => {
  const names = await readdir(invariantsDir, { recursive: true }).catch(() => []);
  const entries = await Promise.all(
    names.map(async (name) => {
      const file = Bun.file(join(invariantsDir, name));
      const stat = await file.stat().catch(() => undefined);
      if (stat === undefined || !stat.isFile()) {
        return undefined;
      }
      const hash = new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex");
      return [relative(invariantsDir, join(invariantsDir, name)), hash] as const;
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
};

const Fingerprint = Schema.Record(Schema.String, Schema.String);

const changedFiles = (before: Record<string, string>, after: Record<string, string>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .toSorted();

const snapshotFile = (input: HookInput) =>
  join(tmpdir(), `aemeth-invariants-${input.session_id}-${input.tool_use_id ?? "bash"}.json`);

const targetsInvariants = (input: HookInput): boolean => {
  const { file_path, notebook_path } = input.tool_input;
  return [file_path, notebook_path].some(
    (target) => typeof target === "string" && target.includes(invariantsPath),
  );
};

const handle = async (input: HookInput): Promise<object | undefined> => {
  if (input.tool_name !== "Bash") {
    return input.hook_event_name === "PreToolUse" && targetsInvariants(input)
      ? ask(approvalReason)
      : undefined;
  }
  const snapshot = snapshotFile(input);
  if (input.hook_event_name === "PreToolUse") {
    await Bun.write(snapshot, JSON.stringify(await fingerprint()));
    return undefined;
  }
  const stored = await Bun.file(snapshot)
    .text()
    .catch(() => "");
  await unlink(snapshot).catch(() => undefined);
  const before = Schema.decodeOption(Schema.fromJsonString(Fingerprint))(stored);
  // No snapshot means the comparison is impossible: report it rather than stay silent.
  if (before._tag === "None") {
    return report(
      "The invariants guard has no snapshot from before this Bash command, so it cannot tell whether packages/core/src/invariants/ changed. Check the folder with git.",
    );
  }
  const changed = changedFiles(before.value, await fingerprint());
  return changed.length > 0
    ? report(`A Bash command changed packages/core/src/invariants/: ${changed.join(", ")}.`)
    : undefined;
};

const decoded = Schema.decodeOption(Schema.fromJsonString(HookInput))(await Bun.stdin.text());

// Silence lets the call go ahead as usual. An unreadable input asks, so the guard fails closed.
const output =
  decoded._tag === "None"
    ? ask(
        "The invariants guard could not read its input, so it cannot tell what this call touches.",
      )
    : await handle(decoded.value);

if (output !== undefined) {
  await Bun.write(Bun.stdout, JSON.stringify(output));
}
