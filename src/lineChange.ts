// What the program measures of the reviewed file during a response (issue #31). Pure.

/** Whether the text changed at all, and the numbers of lines added and removed. */
export type FileChange = Readonly<{ changed: boolean; added: number; removed: number }>;

/** The lines of a text; a trailing newline ends the last line and does not begin another. */
const linesOf = (text: string): readonly string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

/** The change from one text to another: `changed` compares the texts themselves, as the hash comparison does. */
export const lineChange = (before: string, after: string): FileChange => {
  if (before === after) return { changed: false, added: 0, removed: 0 };
  const { midA, midB } = middles(linesOf(before), linesOf(after));
  const { removed, added } = editScript(midA, midB);
  return { changed: true, added: added.length, removed: removed.length };
};

/** The two line lists without their common prefix and suffix, which need no search. */
const middles = (a: readonly string[], b: readonly string[]): Readonly<{ midA: readonly string[]; midB: readonly string[] }> => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { midA: a.slice(start, endA), midB: b.slice(start, endB) };
};

/** The lines a shortest edit script deletes from one text and inserts from another, each list in its text's order. */
export type LineEdits = Readonly<{ removed: readonly string[]; added: readonly string[] }>;

/**
 * The lines removed and added by a shortest edit script between the middles of two texts: Myers' algorithm with the
 * array of each d kept, then walked back from the end. Iterative, so stack safe; the arrays are local to the call.
 */
const editScript = (a: readonly string[], b: readonly string[]): LineEdits => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return { removed: [], added: [] };
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = max;
  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
  }
  // Walk back: trace[d] is the array as it stood before step d, so it holds the end points of step d - 1.
  const removed: string[] = [];
  const added: string[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    // Back over the snake to the end of the edit.
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) {
      x--;
      y--;
    }
    if (down) {
      y--;
      added.push(b[y]);
    } else {
      x--;
      removed.push(a[x]);
    }
  }
  return { removed: removed.reverse(), added: added.reverse() };
};

/** The lines a shortest edit script from one text to the other removes and adds, each in its text's order. */
export const lineEdits = (before: string, after: string): LineEdits => {
  const { midA, midB } = middles(linesOf(before), linesOf(after));
  return editScript(midA, midB);
};
