# 0008: An out-of-band path

Date: 2026-11-23. Status: accepted.

## Decision

Aemeth can always be deployed, rolled back and repaired without Aemeth. The Alchemy CLI, run locally or from CI, is that path, and it is kept working and tested.

## Why

Aemeth operates itself ([0001](0001-product-scope.md)). A recipe that deploys Aemeth runs inside the thing it is deploying, so a bad release could otherwise remove the only way to fix it.

## Rules

- No recipe is the only way to perform an operation on Aemeth.
- Production Aemeth operates staging Aemeth first. A recipe runs against production only after it has succeeded against staging.
- The credentials the out-of-band path needs are never rotated by a recipe without a second, independent credential in place.
