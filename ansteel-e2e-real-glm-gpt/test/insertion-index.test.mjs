import assert from "node:assert/strict";
import test from "node:test";
import { insertionIndex } from "../insertion-index.mjs";

test("returns the README-required insertion indices", () => {
  assert.equal(insertionIndex([], 8), 0);
  assert.equal(insertionIndex([1, 3, 5], 0), 0);
  assert.equal(insertionIndex([1, 3, 5], 3), 1);
  assert.equal(insertionIndex([1, 3, 5], 8), 3);
});

test("returns the array length when inserting after a single value", () => {
  assert.equal(insertionIndex([5], 8), 1);
});
