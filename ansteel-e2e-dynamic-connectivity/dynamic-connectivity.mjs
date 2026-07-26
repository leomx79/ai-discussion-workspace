export function offlineDynamicConnectivity(vertexCount, operations) {
  const n = operations.length;
  if (n === 0) return [];

  // ----- 1. Track active intervals per canonical edge -----
  const key = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);

  const refCount = new Map();
  const intervalStart = new Map();
  const intervals = [];
  const queryMap = new Map();
  let queryCnt = 0;

  for (let i = 0; i < n; i++) {
    const op = operations[i];
    if (op.type === "query") {
      queryMap.set(i, queryCnt++);
      continue;
    }

    const k = key(op.u, op.v);
    const cnt = refCount.get(k) || 0;

    if (op.type === "add") {
      if (cnt === 0) intervalStart.set(k, i);
      refCount.set(k, cnt + 1);
    } else {
      if (cnt === 0) throw new Error("inactive edge");
      if (cnt === 1) {
        intervals.push({ u: op.u, v: op.v, l: intervalStart.get(k), r: i });
        intervalStart.delete(k);
      }
      refCount.set(k, cnt - 1);
    }
  }

  for (const [k, start] of intervalStart) {
    const [u, v] = k.split(",").map(Number);
    intervals.push({ u, v, l: start, r: n });
  }

  // ----- 2. Segment tree -----
  const size = 4 * n;
  const seg = Array.from({ length: size }, () => []);

  const segAdd = (node, nl, nr, ql, qr, edge) => {
    if (ql <= nl && nr <= qr) {
      seg[node].push(edge);
      return;
    }
    const mid = Math.floor((nl + nr) / 2);
    if (ql < mid) segAdd(node * 2, nl, mid, ql, qr, edge);
    if (qr > mid) segAdd(node * 2 + 1, mid, nr, ql, qr, edge);
  };

  for (const { u, v, l, r } of intervals) {
    if (l < r) segAdd(1, 0, n, l, r, { u, v });
  }

  // ----- 3. Rollback DSU -----
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const sz = Array(vertexCount).fill(1);
  const history = [];

  const find = (x) => {
    while (parent[x] !== x) x = parent[x];
    return x;
  };

  const union = (u, v) => {
    if (u === v) return;
    let ru = find(u);
    let rv = find(v);
    if (ru === rv) return;
    if (sz[ru] < sz[rv]) [ru, rv] = [rv, ru];
    history.push({ small: rv, big: ru, oldParent: parent[rv] });
    parent[rv] = ru;
    sz[ru] += sz[rv];
  };

  const snap = () => history.length;
  const rollbackTo = (s) => {
    while (history.length > s) {
      const { small, big, oldParent: oldP } = history.pop();
      parent[small] = oldP;
      sz[big] -= sz[small];
    }
  };

  // ----- 4. DFS -----
  const answers = Array(queryCnt).fill(false);

  const dfs = (node, nl, nr) => {
    const s = snap();
    for (const { u, v } of seg[node]) union(u, v);

    if (nr - nl === 1) {
      const qi = queryMap.get(nl);
      if (qi !== undefined) {
        const op = operations[nl];
        answers[qi] = find(op.u) === find(op.v);
      }
    } else {
      const mid = Math.floor((nl + nr) / 2);
      dfs(node * 2, nl, mid);
      dfs(node * 2 + 1, mid, nr);
    }
    rollbackTo(s);
  };

  dfs(1, 0, n);
  return answers;
}
