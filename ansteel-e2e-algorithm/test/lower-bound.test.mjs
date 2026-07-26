import test from "node:test";
import assert from "node:assert/strict";
import { lowerBound } from "../lower-bound.mjs";

test("returns the insertion index after every element", () => {
  assert.equal(lowerBound([1, 3, 5], 8), 3);
});

test("returns 0 for empty array", () => {
  assert.equal(lowerBound([], 8), 0);
});

test("returns first occurrence for duplicates", () => {
  assert.equal(lowerBound([1, 1, 1, 2, 2, 3], 1), 0);
});

test("returns 0 when target is before all elements", () => {
  assert.equal(lowerBound([1, 3, 5], 0), 0);
});

test("returns index of exact match", () => {
  assert.equal(lowerBound([1, 3, 5], 3), 1);
});
