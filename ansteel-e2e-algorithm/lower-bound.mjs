export function lowerBound(sorted, target) {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sorted[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}
