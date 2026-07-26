import test from "node:test";
import assert from "node:assert/strict";
import { shortestPath } from "../shortest-path.mjs";

test("finds a finite route when a later negative edge improves a settled vertex", () => {
  const result = shortestPath(
    4,
    [
      { from: 0, to: 1, cost: 4 },
      { from: 0, to: 2, cost: 5 },
      { from: 2, to: 1, cost: -3 },
      { from: 1, to: 3, cost: 3 },
      { from: 2, to: 3, cost: 10 },
    ],
    0,
    3,
  );

  assert.deepEqual(result, { cost: 5, path: [0, 2, 1, 3] });
});
