#!/usr/bin/env bats
# bin/ilcli upgrade, in an installed clone on release: it lands on origin/release, then npm ci and npm run build
# (stubbed) on every run, or refuses without changing anything.

load helpers

setup() {
  common_setup
  make_origin
  clone_installed
}

upgrade() { run "$T/installed/bin/ilcli" upgrade; }
npm_line() { printf '%s @%s\n' "$(argv npm "$@")" "$T/installed"; }
expect_npm() {
  local expected
  expected="$(printf '%s\n' "$@")"
  [ "$(cat "$STUB_LOG")" = "$expected" ] || { echo "expected:"; echo "$expected"; echo "got:"; cat "$STUB_LOG"; return 1; }
}

@test "a fast-forward lands on origin/release, then npm ci and npm run build, and says what it did" {
  local old
  old="$(git -C "$T/installed" rev-parse --short HEAD)"
  advance release "Tested change"
  upgrade
  [ "$status" -eq 0 ]
  [ "$(head_of "$T/installed")" = "$(head_of "$T/origin.git" release)" ]
  expect_npm "$(npm_line ci)" "$(npm_line run build)"
  [[ "$output" == *"$old"* ]]
  [[ "$output" == *"$(git -C "$T/installed" rev-parse --short HEAD)"* ]]
  [[ "$output" == *"Tested change"* ]]
  [[ "$output" == *"web server"* ]]
  [[ "$output" == *"reload every open tab"* ]]
  # Issue #88 (W1-R1-1): the page is the only interface, so no terminal runs are mentioned.
  [[ "$output" != *"terminal"* ]] || { echo "$output"; return 1; }
}

@test "already up to date still runs npm ci and npm run build" {
  upgrade
  [ "$status" -eq 0 ]
  [[ "$output" == *"already at"* ]]
  expect_npm "$(npm_line ci)" "$(npm_line run build)"
}

@test "a modified tracked file is refused, HEAD unchanged, no npm" {
  advance release "Tested change"
  local before
  before="$(head_of "$T/installed")"
  echo change >> "$T/installed/package-lock.json"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"local modifications"* ]]
  [[ "$output" == *"package-lock.json"* ]]
  [ "$(head_of "$T/installed")" = "$before" ]
  [ ! -s "$STUB_LOG" ]
}

@test "an untracked file is refused" {
  touch "$T/installed/stray.txt"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"stray.txt"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "ignored files (node_modules, web/dist) are not local modifications" {
  mkdir -p "$T/installed/node_modules/x" "$T/installed/web/dist"
  touch "$T/installed/node_modules/x/a" "$T/installed/web/dist/index.html"
  upgrade
  [ "$status" -eq 0 ]
}

@test "a branch other than release is refused, naming it" {
  git -C "$T/installed" switch -q -c main origin/main
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"'main'"* ]]
  [[ "$output" == *"release"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "release without an upstream is refused with the setup command" {
  git -C "$T/installed" branch -q --unset-upstream
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"origin/release"* ]]
  [[ "$output" == *"git branch --set-upstream-to=origin/release release"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "release tracking another branch is refused" {
  git -C "$T/installed" branch -q --set-upstream-to=origin/main release
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not track origin/release"* ]]
}

@test "a local commit ahead of origin/release is refused and listed, HEAD unchanged, no npm" {
  commit_in "$T/installed" "Hand-made fix"
  local before
  before="$(head_of "$T/installed")"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"Hand-made fix"* ]]
  [[ "$output" == *"origin/release"* ]]
  [ "$(head_of "$T/installed")" = "$before" ]
  [ ! -s "$STUB_LOG" ]
}

@test "a diverged release is refused the same way, nothing reset" {
  advance release "Tested change"
  commit_in "$T/installed" "Hand-made fix"
  local before
  before="$(head_of "$T/installed")"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"Hand-made fix"* ]]
  [ "$(head_of "$T/installed")" = "$before" ]
  [ ! -s "$STUB_LOG" ]
}

@test "an unreachable origin is refused with nothing changed" {
  git -C "$T/installed" remote set-url origin "$T/missing.git"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"nothing was changed"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "a failing npm ci stops before the build, names the commit, and a retry installs again" {
  advance release "Tested change"
  export STUB_NPM_FAIL=ci
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"npm ci failed"* ]]
  [[ "$output" == *"$(git -C "$T/installed" rev-parse --short HEAD)"* ]]
  [[ "$output" == *"bin/ilcli upgrade"* ]]
  expect_npm "$(npm_line ci)"
  unset STUB_NPM_FAIL
  : > "$STUB_LOG"
  upgrade
  [ "$status" -eq 0 ]
  expect_npm "$(npm_line ci)" "$(npm_line run build)"
}

@test "a failing build exits non-zero and says so" {
  export STUB_NPM_FAIL="run build"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"npm run build failed"* ]]
  [[ "$output" == *"bin/ilcli upgrade"* ]]
}
