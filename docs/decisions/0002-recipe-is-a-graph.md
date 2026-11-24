# 0002: A recipe is a graph

Date: 2026-11-23. Status: accepted.

## Decision

A recipe is stored as a graph: nodes are block instances, and edges carry control flow. Typed data travels from one block's outputs to another's inputs on the bindings of a step's inputs, each of which names the output it takes. This holds from the first version, even though the first editor shows a recipe as an ordered list.

*Changed on 2026-11-23, at the close of M1, with the owner's approval ([M1 spec](../milestones/m1.md), decision 6). The first wording had edges carry typed data as well. One step may take inputs from several earlier steps that are not its direct predecessor, and a binding names its source exactly where an edge would have to be repeated per input. The format is set out in [0009](0009-recipe-format-block-contract-and-run-model.md).*

## Why

The intended editor is a drag-and-drop canvas. Storing a graph from the start means the canvas is a second view of the same document, with no change to the recipe format, the validator or the engine.

## Consequences

- The list editor reads and writes a restricted shape of the graph.
- Whether one block's output fits another's input is checked on data when the recipe is validated, not by the TypeScript compiler. How to do this is the main design problem of milestone 1.
- Published recipe versions are immutable. Editing creates a new version.
- Until the builder exists, recipes are files in this repository, validated in CI and loaded by the engine at deploy. Merging is publishing. From milestone 4 the builder stores versions in D1, and the same validator gates both routes.
- A JSON Schema is generated from the recipe Schema, so any tool that writes JSON can author a recipe.
- The graph is bounded. Cycles are rejected; repetition is a fixed series of stages or a for-each over a list. The validator enforces a cap on size and branching and reports when a recipe exceeds it, so path checking always finishes.
