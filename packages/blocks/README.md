# packages/blocks

The block library. Each block is one typed step (an action, a check or a gate) that declares its inputs, outputs, reads, writes and undo.

Depends on `packages/core` for the block schema. A block must not assume it runs inside the Worker (see [decision 0005](../../docs/decisions/0005-where-steps-run.md)).
