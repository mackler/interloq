import assert from "node:assert/strict";
import { test } from "node:test";
import { hostDirOf, identify, ownName, parseMountinfo, type MountTable } from "../src/hostDir.ts";

// Issue #29: the mount record of /workspace as read from the development container on 7 Oct 2026, verbatim.
const REAL = "191 166 253:0 /home/mackler/work/interloq-dev /workspace rw,noatime - ext4 /dev/mapper/root_fs rw";
const ROOT = "166 101 0:52 / / rw,relatime - overlay overlay";
const real: MountTable = [{ root: "/home/mackler/work/interloq-dev", point: "/workspace" }];

test("the real line parses to its root and mount point", () => {
  assert.deepEqual(parseMountinfo(REAL), real);
});

test("escaped space, tab, newline and backslash are unescaped in the root and the mount point", () => {
  const line = "1 2 8:1 /home/me/my\\040project\\011a\\012b\\134c /work\\040space rw - ext4 /dev/sda1 rw";
  assert.deepEqual(parseMountinfo(line), [{ root: "/home/me/my project\ta\nb\\c", point: "/work space" }]);
});

test("a root of / is left out", () => {
  assert.deepEqual(parseMountinfo([ROOT, REAL].join("\n")), real);
});

test("optional fields before the separator are skipped, whatever their number", () => {
  const line = "191 166 253:0 /home/mackler/work/interloq-dev /workspace rw,noatime shared:1 master:2 - ext4 /dev/mapper/root_fs rw";
  assert.deepEqual(parseMountinfo(line), real);
});

test("a line without the separator, a short line and the empty text give no record", () => {
  assert.deepEqual(parseMountinfo("191 166 253:0 /a /b rw ext4 /dev/x rw"), []);
  assert.deepEqual(parseMountinfo("191 166 253:0 /a"), []);
  assert.deepEqual(parseMountinfo(""), []);
});

test("hostDirOf: the mount point itself, a path under it, a trailing slash, and a path boundary", () => {
  assert.equal(hostDirOf(real, "/workspace"), "/home/mackler/work/interloq-dev");
  assert.equal(hostDirOf(real, "/workspace/"), "/home/mackler/work/interloq-dev");
  assert.equal(hostDirOf(real, "/workspace/sub"), "/home/mackler/work/interloq-dev/sub");
  assert.equal(hostDirOf(real, "/workspacely"), null);
  assert.equal(hostDirOf(real, "workspace"), null);
  assert.equal(hostDirOf([], "/workspace"), null);
});

test("hostDirOf: the longest containing mount point wins, in either order", () => {
  const nested: MountTable = [{ root: "/host/outer", point: "/w" }, { root: "/host/inner", point: "/w/sub" }];
  assert.equal(hostDirOf(nested, "/w/sub/x"), "/host/inner/x");
  assert.equal(hostDirOf([...nested].reverse(), "/w/sub/x"), "/host/inner/x");
  assert.equal(hostDirOf(nested, "/w/other"), "/host/outer/other");
});

test("identify: the host directory where found, the path as given otherwise", () => {
  assert.equal(identify(real, "/workspace"), "/home/mackler/work/interloq-dev");
  assert.equal(identify(real, "/tmp/repo"), "/tmp/repo");
  assert.equal(identify([], "/workspace"), "/workspace");
});

test("ownName: the last component, trailing slashes ignored, / for the root", () => {
  assert.equal(ownName("/home/mackler/work/interloq-dev"), "interloq-dev");
  assert.equal(ownName("/workspace/"), "workspace");
  assert.equal(ownName("/"), "/");
  assert.equal(ownName("//"), "/");
});
