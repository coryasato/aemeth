# packages/blocks

The block library. Each block is one typed step (an action, a check or a gate) that declares its inputs, outputs, reads, writes and undo.

Depends on `packages/core` for the block schema. A block must not assume it runs inside the Worker (see [decision 0005](../../docs/decisions/0005-where-steps-run.md)).

- `src/*.ts` (`d1.ts`, `gate.ts`, …): the declarations, as data.
- `src/implement.ts`: the contract between a block's code and the engine. `implement({ spec, uses, run })` makes a block the engine can run: `uses` lists the services the code reaches the outside world through, and `run` is typed to need exactly those, so code that uses another does not compile. It also holds the services a block can ask for that the engine provides, such as `Secrets`. The implementations of the restore drill's blocks arrive in M2 Part D.
