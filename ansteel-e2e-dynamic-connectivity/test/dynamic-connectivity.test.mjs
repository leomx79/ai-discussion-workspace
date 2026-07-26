import assert from "node:assert/strict";
import test from "node:test";
import { offlineDynamicConnectivity } from "../dynamic-connectivity.mjs";

test("answers connectivity across additions and removals", () => {
  const answers = offlineDynamicConnectivity(5, [
    { type: "add", u: 0, v: 1 },
    { type: "add", u: 1, v: 2 },
    { type: "query", u: 0, v: 2 },
    { type: "remove", u: 1, v: 2 },
    { type: "query", u: 0, v: 2 },
    { type: "add", u: 2, v: 3 },
    { type: "add", u: 1, v: 2 },
    { type: "query", u: 0, v: 3 },
  ]);

  assert.deepEqual(answers, [true, false, true]);
});

test("reference-counts duplicate undirected edges", () => {
  const answers = offlineDynamicConnectivity(3, [
    { type: "add", u: 0, v: 1 },
    { type: "add", u: 1, v: 0 },
    { type: "remove", u: 0, v: 1 },
    { type: "query", u: 0, v: 1 },
    { type: "remove", u: 1, v: 0 },
    { type: "query", u: 0, v: 1 },
  ]);

  assert.deepEqual(answers, [true, false]);
});

test("rejects removal of an inactive edge", () => {
  assert.throws(
    () => offlineDynamicConnectivity(2, [{ type: "remove", u: 0, v: 1 }]),
    /inactive edge/i,
  );
});

test("self-loop does not affect connectivity and queries return true", () => {
  const answers = offlineDynamicConnectivity(3, [
    { type: "add", u: 1, v: 1 },
    { type: "query", u: 1, v: 1 },
    { type: "add", u: 0, v: 1 },
    { type: "query", u: 0, v: 1 },
    { type: "remove", u: 1, v: 1 },
    { type: "query", u: 0, v: 1 },
  ]);

  assert.deepEqual(answers, [true, true, true]);
});

test("reactivates edge across two disjoint active intervals", () => {
  const answers = offlineDynamicConnectivity(2, [
    { type: "add", u: 0, v: 1 },
    { type: "query", u: 0, v: 1 },
    { type: "remove", u: 0, v: 1 },
    { type: "query", u: 0, v: 1 },
    { type: "add", u: 0, v: 1 },
    { type: "query", u: 0, v: 1 },
  ]);

  assert.deepEqual(answers, [true, false, true]);
});
