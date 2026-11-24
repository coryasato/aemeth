// PreToolUse hook (spec decision 7 in docs/milestones/m0.md).
// Asks the person for approval before a tool edits anything under packages/core/src/invariants/.
// It asks rather than blocks, because adding an invariant is allowed; changing or removing one
// needs the owner's explicit approval (CLAUDE.md, hard rule 1).
import { Schema } from "effect";

const invariantsFolder = "packages/core/src/invariants/";

const HookInput = Schema.Struct({
  tool_name: Schema.String,
  tool_input: Schema.Record(Schema.String, Schema.Unknown),
});

const touchesInvariants = (input: typeof HookInput.Type): boolean => {
  const { file_path, notebook_path, command } = input.tool_input;
  // Bash is included so a `sed -i` or a redirect into the folder is flagged too.
  const targets = [file_path, notebook_path, command].filter(
    (value): value is string => typeof value === "string",
  );
  return targets.some((target) => target.includes(invariantsFolder));
};

const decoded = Schema.decodeOption(Schema.fromJsonString(HookInput))(await Bun.stdin.text());

const ask = (reason: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  });

// Silence lets the call go ahead as usual; an unreadable input asks, so the guard fails closed.
if (decoded._tag === "None") {
  await Bun.write(
    Bun.stdout,
    ask("The invariants guard could not read its input, so it cannot tell what this call touches."),
  );
} else if (touchesInvariants(decoded.value)) {
  await Bun.write(
    Bun.stdout,
    ask(
      "This touches packages/core/src/invariants/, which the owner writes. Adding an invariant is allowed; changing or removing one needs the owner's explicit approval (CLAUDE.md, hard rule 1).",
    ),
  );
}
