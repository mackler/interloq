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
  if [ "$#" -eq 0 ]; then expected=""; else expected="$(printf '%s\n' "$@")"; fi
  [ "$(grep '^npm ' "$STUB_LOG" || true)" = "$expected" ] || { echo "expected:"; echo "$expected"; echo "got:"; cat "$STUB_LOG"; return 1; }
}
no_npm() { ! grep -q '^npm ' "$STUB_LOG"; }

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
  [ ! -s "$STUB_LOG" ]
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
  no_npm
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
  no_npm
}

@test "an unreachable origin is refused with nothing changed" {
  git -C "$T/installed" remote set-url origin "$T/missing.git"
  upgrade
  [ "$status" -ne 0 ]
  [[ "$output" == *"nothing was changed"* ]]
  no_npm
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

# Issue #104: upgrade refuses while a process in a running container runs anything from the installed copy.

WEB_LINE='101 node /opt/interloq/src/web.ts'
CLAUDE_LINE='202 /opt/interloq/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json'
CODEX_LINE='303 /opt/interloq/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex exec --experimental-json'
LAUNCHER_LINE='7 docker compose -f /home/u/work/interloq-dev/compose.cc.yaml exec cc node /opt/interloq/src/web.ts'
LAUNCHER_PATH_LINE='8 /usr/local/bin/docker compose -f /x/compose.cc.yaml exec cc node /opt/interloq/src/web.ts'

# Remembers HEAD and the installed clone's origin/release, so that untouched can show nothing changed: no
# fast-forward, no fetch (the ref would have moved, since release was advanced), no npm.
remember() {
  HEAD_BEFORE="$(head_of "$T/installed")"
  REF_BEFORE="$(head_of "$T/installed" origin/release)"
}
untouched() {
  [ "$(head_of "$T/installed")" = "$HEAD_BEFORE" ]
  [ "$(head_of "$T/installed" origin/release)" = "$REF_BEFORE" ]
  no_npm
}
upgraded() {
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(head_of "$T/installed")" = "$(head_of "$T/origin.git" release)" ]
  expect_npm "$(npm_line ci)" "$(npm_line run build)"
}
# mounts_copy <id>...: each container mounts the installed copy at /opt/interloq, as every project container does.
mounts_copy() {
  local id
  for id in "$@"; do container_mounts "$id" "$T/installed" /opt/interloq; done
}
refused_naming() {
  [ "$status" -ne 0 ]
  [[ "$output" == *"refused"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"--force"* ]] || { echo "$output"; return 1; }
  local text
  for text in "$@"; do
    [[ "$output" == *"$text"* ]] || { echo "missing: $text"; echo "$output"; return 1; }
  done
}

@test "a container running files of the installed copy refuses, naming it and the command lines, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS=$'c1 proj-a\nc2 proj-b'
  mounts_copy c1 c2
  container_procs c1 "$WEB_LINE" "$CLAUDE_LINE"
  upgrade
  refused_naming proj-a c1 "${WEB_LINE#* }" "${CLAUDE_LINE#* }" "until its run ends"
  [[ "$output" != *"proj-b"* ]] || { echo "$output"; return 1; }
  untouched
}

@test "containers running nothing of the installed copy proceed, each searched once" {
  advance release "Tested change"
  export STUB_DOCKER_PS=$'c1 proj-a\nc2 proj-b'
  mounts_copy c1 c2
  container_procs c1 "1 bash"
  container_procs c2 "2 sleep infinity"
  upgrade
  upgraded
  [ "$(grep -c '^docker \[exec\] \[c1\] \[pgrep\]' "$STUB_LOG")" -eq 1 ]
  [ "$(grep -c '^docker \[exec\] \[c2\] \[pgrep\]' "$STUB_LOG")" -eq 1 ]
}

@test "no running containers proceed" {
  advance release "Tested change"
  upgrade
  upgraded
  grep -q '^docker \[ps\]' "$STUB_LOG"
}

@test "a failed docker ps refuses as inconclusive, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_FAIL=ps
  upgrade
  refused_naming "could not check"
  untouched
}

@test "a container without pgrep refuses as inconclusive, naming it, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_fails c1 127 'exec: "pgrep": executable file not found'
  upgrade
  refused_naming "could not check" proj-a c1 pgrep /opt/interloq procps
  untouched
}

@test "a container that stopped during the search refuses as inconclusive, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_fails c1 1 'Error response from daemon: container c1 is not running'
  upgrade
  refused_naming "could not check" proj-a c1
  untouched
}

@test "a search that fails with stderr beginning with an empty line refuses as inconclusive, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_fails c1 1 $'\nError response from daemon: container c1 is not running'
  upgrade
  refused_naming "could not check" proj-a c1 "Error response from daemon"
  untouched
}

@test "docker missing refuses as inconclusive, nothing touched" {
  advance release "Tested change"
  remember
  path_without_docker
  upgrade
  refused_naming "could not check" "docker is not available"
  untouched
}

@test "--force skips the check, says so, and upgrades" {
  advance release "Tested change"
  export STUB_DOCKER_PS=$'c1 proj-a\nc2 proj-b'
  mounts_copy c1 c2
  container_procs c1 "$WEB_LINE" "$CLAUDE_LINE"
  run "$T/installed/bin/ilcli" upgrade --force
  upgraded
  [[ "$output" == *"skipped"* ]]
  ! grep -q '^docker ' "$STUB_LOG"
}

@test "--force proceeds where docker is missing" {
  advance release "Tested change"
  path_without_docker
  run "$T/installed/bin/ilcli" upgrade --force
  upgraded
}

@test "a host-side docker launcher naming the copy does not count as a user" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  local line
  for line in "$LAUNCHER_LINE" "$LAUNCHER_PATH_LINE"; do
    : > "$STUB_LOG"
    container_procs c1 "$line"
    upgrade
    upgraded
  done
}

@test "the Codex binary counts as a user" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 "$CODEX_LINE"
  upgrade
  refused_naming "${CODEX_LINE#* }"
  untouched
}

@test "the copy's path after interpreter options counts as a user" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  local line
  for line in '404 node --inspect /opt/interloq/src/web.ts' '405 /usr/bin/env node /opt/interloq/src/web.ts'; do
    : > "$STUB_LOG"
    remember
    container_procs c1 "$line"
    upgrade
    refused_naming "${line#* }"
    untouched
  done
}

@test "a launcher beside a user still refuses, naming the user and not the launcher" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 "$LAUNCHER_LINE" "$WEB_LINE"
  upgrade
  refused_naming "${WEB_LINE#* }"
  [[ "$output" != *"docker compose"* ]] || { echo "$output"; return 1; }
  untouched
}

# W1-R1-1: a temporary file that cannot be created makes the check inconclusive, never a pass.
@test "a temporary file that cannot be created for a container's search refuses as inconclusive" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 '1 bash'
  export STUB_MKTEMP_FAIL_AFTER=2
  upgrade
  refused_naming "could not check" proj-a c1 "temporary file"
  untouched
}

@test "a temporary file that cannot be created for the container listing refuses as inconclusive" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 '1 bash'
  export STUB_MKTEMP_FAIL_AFTER=0
  upgrade
  refused_naming "could not check" "temporary file"
  untouched
  ! grep -q '^docker \[exec\]' "$STUB_LOG"
}

# Issue #172: only the containers that mount the installed copy are searched, at the path they mount it at.

@test "a container that does not mount the copy is not searched, so one without pgrep does not stop the upgrade" {
  advance release "Tested change"
  export STUB_DOCKER_PS=$'c1 proj-a\nc2 database'
  mounts_copy c1
  container_procs c1 '1 bash'
  container_mounts c2 /var/lib/docker/volumes/db/_data /var/lib/postgresql/data
  container_fails c2 127 'exec: "pgrep": executable file not found'
  upgrade
  upgraded
  grep -q '^docker \[inspect\] \[--format\] \[.*\] \[c2\]$' "$STUB_LOG"
  ! grep -q '^docker \[exec\] \[c2\]' "$STUB_LOG"
}

@test "a container whose mounts cannot be read refuses as inconclusive, unsearched, nothing touched" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  container_procs c1 '1 bash'
  container_inspect_fails c1 1 'Error: No such object: c1'
  upgrade
  refused_naming "could not check" proj-a c1 mounts "No such object"
  ! grep -q '^docker \[exec\] \[c1\]' "$STUB_LOG"
  untouched
}

@test "the copy mounted at another path is searched at that path" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed" /srv/il
  container_procs c1 '7 node /srv/il/src/web.ts'
  upgrade
  refused_naming 'node /srv/il/src/web.ts' /srv/il
  untouched
}

@test "a container mounting the copy at another path does not count a process of /opt/interloq" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed" /srv/il
  container_procs c1 '8 node /opt/interloq/src/web.ts'
  upgrade
  upgraded
}

@test "a mount of a directory above the copy counts the copy's path below it" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T" /w
  container_procs c1 '9 node /w/installed/src/web.ts'
  upgrade
  refused_naming 'node /w/installed/src/web.ts'
  untouched
}

@test "a mount whose source only begins with the copy's path is not the copy, and is not searched" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed-old" /opt/interloq
  container_procs c1 "$WEB_LINE"
  upgrade
  upgraded
  ! grep -q '^docker \[exec\] \[c1\]' "$STUB_LOG"
}

@test "the copy reached through a symbolic link matches a mount of its resolved path" {
  advance release "Tested change"
  remember
  ln -s "$T/installed" "$T/link"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$(cd "$T/installed" && pwd -P)" /opt/interloq
  container_procs c1 "$WEB_LINE"
  run "$T/link/bin/ilcli" upgrade
  refused_naming "${WEB_LINE#* }"
  untouched
}

@test "the characters of a mount path are matched literally" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed" /srv/inter.loq
  container_procs c1 '10 node /srv/interXloq/src/web.ts'
  upgrade
  upgraded
}

@test "a mount path with glob characters is kept beside a path it matches as a pattern" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed" /srv/abc
  container_mounts c1 "$T/installed" '/srv/a*c'
  container_procs c1 '7 node /srv/a*c/src/web.ts'
  upgrade
  refused_naming '7 node /srv/a*c/src/web.ts'
  untouched
}

@test "a temporary file that cannot be created for reading a container's mounts refuses as inconclusive" {
  advance release "Tested change"
  remember
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 '1 bash'
  export STUB_MKTEMP_FAIL_AFTER=1
  upgrade
  refused_naming "could not check" proj-a c1 "temporary file"
  untouched
}

@test "the stub and the script agree on the call that reads a container's mounts" {
  # shellcheck source=/dev/null
  source "$REPO_ROOT/bin/ilcli.bashly/lib/common.sh"
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  mounts_copy c1
  container_procs c1 '1 bash'
  upgrade
  upgraded
  grep -qxF "$(argv docker inspect --format "$MOUNTS_TEMPLATE" c1)" "$STUB_LOG" || { cat "$STUB_LOG"; return 1; }
  grep -q '^docker \[exec\] \[c1\] \[pgrep\]' "$STUB_LOG"
}

@test "a single file of the copy mounted counts when it is executed" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed/node_modules/codex/bin/codex" /usr/local/bin/codex
  local line
  for line in '303 /usr/local/bin/codex exec' '304 /usr/local/bin/codex'; do
    : > "$STUB_LOG"
    remember
    container_procs c1 "$line"
    upgrade
    refused_naming "${line#* }"
    untouched
  done
}

@test "a longer name beginning with a mounted file's path does not count" {
  advance release "Tested change"
  export STUB_DOCKER_PS='c1 proj-a'
  container_mounts c1 "$T/installed/node_modules/codex/bin/codex" /usr/local/bin/codex
  container_procs c1 '305 /usr/local/bin/codex-other run'
  upgrade
  upgraded
}
