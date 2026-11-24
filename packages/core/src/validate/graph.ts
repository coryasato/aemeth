import { Option } from "effect";

// Hand-written rather than `effect/Graph`, which is marked unstable (M1 decision 10). A recipe
// has at most a few dozen nodes, so plain depth-first search is enough.

/**
 * A cycle among the nodes, as the nodes on it in order, or nothing when there is none.
 * `next` gives the nodes a node has an edge to.
 */
export const findCycle = <N>(
  nodes: ReadonlyArray<N>,
  next: (node: N) => ReadonlyArray<N>,
): Option.Option<ReadonlyArray<N>> => {
  const done = new Set<N>();
  const visit = (node: N, trail: ReadonlyArray<N>): Option.Option<ReadonlyArray<N>> => {
    const at = trail.indexOf(node);
    if (at !== -1) {
      return Option.some(trail.slice(at));
    }
    if (done.has(node)) {
      return Option.none();
    }
    for (const successor of next(node)) {
      const cycle = visit(successor, [...trail, node]);
      if (Option.isSome(cycle)) {
        return cycle;
      }
    }
    done.add(node);
    return Option.none();
  };
  for (const node of nodes) {
    const cycle = visit(node, []);
    if (Option.isSome(cycle)) {
      return cycle;
    }
  }
  return Option.none();
};

/**
 * The nodes reachable from `start` in an order where every node comes after all the nodes with
 * an edge to it. Only for a graph with no cycle.
 */
export const topologicalOrder = <N>(start: N, next: (node: N) => ReadonlyArray<N>): Array<N> => {
  const done = new Set<N>();
  const finished: Array<N> = [];
  const visit = (node: N): void => {
    if (!done.has(node)) {
      done.add(node);
      for (const successor of next(node)) {
        visit(successor);
      }
      finished.push(node);
    }
  };
  visit(start);
  return finished.toReversed();
};
