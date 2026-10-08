// The project's host directory (issue #29; pure, also imported by the browser): the directory on the developer's own
// machine that a path inside the container is mounted from, read from the kernel's mount table, so that two windows of
// two servers can be told apart by the files each run changes.
//
// `parseMountinfo` reads the lines of `/proc/self/mountinfo`. Of each line it reads field 4, the root (the path within
// the mounted filesystem), and field 5, the mount point; their positions are fixed. A line is a record only if it has
// the single-field `-` separator after the optional fields, whose number varies and is never assumed. Both paths are
// unescaped (`\040` space, `\011` tab, `\012` newline, `\134` backslash, and any other three-digit octal escape).
//
// The limit of this method: field 4 is a path within the mounted filesystem, so it is an absolute host path only when
// that filesystem is the host's root filesystem mounted at `/`, which is the developer's arrangement. Where it is not,
// the string is still the best available identification of the project and still distinguishes two projects, which is
// what issue #29 asks for. No attempt is made to detect the difference.

/** One bind mount: the path within the mounted filesystem (never `/`, which carries no information) and where it is mounted. */
export type MountRecord = Readonly<{ root: string; point: string }>;

/** The records of the mount table that can identify a path, both paths unescaped. */
export type MountTable = ReadonlyArray<MountRecord>;

/** A mountinfo path with its octal escapes replaced by the characters they stand for. */
const unescape = (field: string): string => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** A path without its trailing slashes; `/` (or slashes alone) stays `/`. */
const trimmed = (path: string): string => path.replace(/\/+$/, "") || "/";

/** The record of one line, or null: at least the six fixed fields, then the separator, then the three after it. */
const recordOf = (line: string): MountRecord | null => {
  const fields = line.split(" ");
  const separator = fields.indexOf("-", 6);
  if (separator < 0 || fields.length < separator + 4) return null;
  const root = unescape(fields[3] ?? "");
  const point = unescape(fields[4] ?? "");
  return root.startsWith("/") && point.startsWith("/") && root !== "/" ? { root, point } : null;
};

/** The records of a mountinfo text; a line that cannot be read, or whose root is `/`, is left out. Total. */
export const parseMountinfo = (text: string): MountTable =>
  text.split("\n").flatMap((line) => {
    const record = recordOf(line);
    return record === null ? [] : [record];
  });

/** Whether the mount point contains the path, at a path boundary. */
const contains = (point: string, path: string): boolean => point === "/" || path === point || path.startsWith(`${point}/`);

/** The host directory of an absolute path: the root of the longest mount point that contains it, with the rest of the path appended; null where none does. */
export const hostDirOf = (table: MountTable, path: string): string | null => {
  if (!path.startsWith("/")) return null;
  const p = trimmed(path);
  const longest = table
    .map((r) => ({ ...r, point: trimmed(r.point) }))
    .filter((r) => contains(r.point, p))
    .reduce<MountRecord | null>((best, r) => (best === null || r.point.length > best.point.length ? r : best), null);
  if (longest === null) return null;
  const rest = longest.point === "/" ? p : p.slice(longest.point.length);
  return rest === "/" ? longest.root : longest.root + rest;
};

/** The identification of a path: its host directory, or the path as given where that cannot be determined. */
export const identify = (table: MountTable, path: string): string => hostDirOf(table, path) ?? path;

/** The directory's own name: the last component of a location, trailing slashes ignored; `/` for the root. */
export const ownName = (location: string): string => {
  const t = trimmed(location);
  return t.slice(t.lastIndexOf("/") + 1) || t;
};
