# 0002: A recipe is a graph

Date: 2026-11-23. Status: accepted.

## Decision

A recipe is stored as a graph: nodes are block instances, and edges carry control flow and typed data from one block's outputs to another's inputs. This holds from the first version, even though the first editor shows a recipe as an ordered list.

## Why

The intended editor is a drag-and-drop canvas. Storing a graph from the start means the canvas is a second view of the same document, with no change to the recipe format, the validator or the engine.

## Consequences

- The list editor reads and writes a restricted shape of the graph.
- Whether one block's output fits another's input is checked on data when the recipe is validated, not by the TypeScript compiler. How to do this is the main design problem of milestone 1.
- Published recipe versions are immutable. Editing creates a new version.
- Until the builder exists, recipes are files in this repository, validated in CI and loaded by the engine at deploy. Merging is publishing. From milestone 4 the builder stores versions in D1, and the same validator gates both routes.
- A JSON Schema is generated from the recipe Schema, so any tool that writes JSON can author a recipe.
- The graph is bounded. Cycles are rejected; repetition is a fixed series of stages or a for-each over a list. The validator enforces a cap on size and branching and reports when a recipe exceeds it, so path checking always finishes.
