export function shortestPath(vertexCount, edges, source, destination) {
  const distance = Array(vertexCount).fill(Infinity);
  const visited = Array(vertexCount).fill(false);
  const predecessor = Array(vertexCount).fill(null);
  distance[source] = 0;

  for (let iteration = 0; iteration < vertexCount; iteration += 1) {
    let current = -1;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (!visited[vertex] && (current === -1 || distance[vertex] < distance[current])) {
        current = vertex;
      }
    }
    if (current === -1 || distance[current] === Infinity) break;
    visited[current] = true;

    for (const { from, to, cost } of edges) {
      if (from !== current || visited[to]) continue;
      const candidate = distance[from] + cost;
      if (candidate < distance[to]) {
        distance[to] = candidate;
        predecessor[to] = from;
      }
    }
  }

  if (distance[destination] === Infinity) return null;
  const path = [];
  for (let vertex = destination; vertex !== null; vertex = predecessor[vertex]) path.push(vertex);
  return { cost: distance[destination], path: path.reverse() };
}
