# Offline Dynamic Connectivity

Implement `offlineDynamicConnectivity(vertexCount, operations)` in `dynamic-connectivity.mjs`.

Each operation is one of:

- `{ type: "add", u, v }`: add one undirected edge occurrence.
- `{ type: "remove", u, v }`: remove one previously added occurrence of that edge.
- `{ type: "query", u, v }`: ask whether `u` and `v` are connected after all preceding operations.

Return one boolean for each query, in query order. Edges are undirected, self-loops are allowed, and duplicate edge occurrences are reference-counted: connectivity remains while at least one occurrence is active. Removing an absent edge must throw.

The intended solution is offline: map each active edge occurrence to a time interval, distribute intervals over a segment tree of the operation timeline, and evaluate with a rollback disjoint-set union. Target complexity is `O((operations + active intervals) log operations log vertexCount)` time and `O((operations + vertexCount) log operations)` space.
