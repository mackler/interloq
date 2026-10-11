#!/usr/bin/env bats
# The docker commands of bin/ilcli pass exactly what bin/dev-claude passed to docker compose (stubbed).

bats_require_minimum_version 1.5.0

load helpers

setup() { common_setup; }

up() { argv docker compose -f "$COMPOSE" up -d --no-recreate; }
ps_line() { argv docker compose -f "$COMPOSE" ps -a -q cc; }
inspect_line() { argv docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$1"; }
hash_line() { argv docker compose -f "$COMPOSE" config --hash cc; }
# The calls before the program when no container exists: the detection finds none, then up.
start() { ps_line; up; }
# The calls before the program when container abc exists: the detection reads both hashes, then up.
start_existing() { ps_line; inspect_line abc; hash_line; up; }
claude() { argv docker compose -f "$COMPOSE" exec -it cc claude "$@"; }
web_line() { argv docker compose -f "$COMPOSE" exec -it cc node /opt/interloq/src/web.ts "$@"; }

expect_log() {
  local expected
  expected="$(printf '%s\n' "$@")"
  [ "$(cat "$STUB_LOG")" = "$expected" ] || { echo "expected:"; echo "$expected"; echo "got:"; cat "$STUB_LOG"; return 1; }
}

@test "no arguments starts the container, then claude" {
  run "$ILCLI"
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(claude)"
}

@test "an unknown first argument goes to claude" {
  run "$ILCLI" --continue
  expect_log "$(start)" "$(claude --continue)"
}

# The developer's decision of 7 Oct 2026 (issue #10), which replaced the narrower one of 27 Sep 2026: --help and -h
# after every subcommand, run included, show its usage; -- passes the rest on.
@test "run --help and run -h show run's usage and make no docker call" {
  for flag in --help -h; do
    run "$ILCLI" run $flag
    [ "$status" -eq 0 ]
    [[ "$output" == *"ilcli run"* ]] || { echo "run $flag: no usage"; echo "$output"; return 1; }
    [[ "$output" == *"Usage"* ]]
  done
  [ ! -s "$STUB_LOG" ]
}

@test "-c and --continue reach claude unchanged" {
  run "$ILCLI" --continue
  run "$ILCLI" -c
  run "$ILCLI" run -c
  run "$ILCLI" run --continue
  expect_log "$(start)" "$(claude --continue)" "$(start)" "$(claude -c)" "$(start)" "$(claude -c)" "$(start)" "$(claude --continue)"
}

@test "run --resume reaches claude" {
  run "$ILCLI" run --resume
  expect_log "$(start)" "$(claude --resume)"
}

@test "arguments pass through without splitting, in order" {
  run "$ILCLI" -abc --model=opus
  run "$ILCLI" run -p "two words"
  expect_log "$(start)" "$(claude -abc --model=opus)" "$(start)" "$(claude -p "two words")"
}

@test "--version and -v as the first argument reach claude" {
  run "$ILCLI" --version
  run "$ILCLI" -v
  expect_log "$(start)" "$(claude --version)" "$(start)" "$(claude -v)"
}

@test "a literal -- is kept, element by element" {
  run "$ILCLI" run -- --help
  run "$ILCLI" -- --help
  run "$ILCLI" run a -- b
  expect_log "$(start)" "$(claude -- --help)" "$(start)" "$(claude -- --help)" "$(start)" "$(claude a -- b)"
}

@test "shell opens bash" {
  run "$ILCLI" shell
  expect_log "$(start)" "$(argv docker compose -f "$COMPOSE" exec -it cc bash)"
}

@test "build builds, down stops" {
  run "$ILCLI" build
  run "$ILCLI" down
  expect_log "$(argv docker compose -f "$COMPOSE" build)" "$(argv docker compose -f "$COMPOSE" down)"
}

@test "shell, build and down ignore ordinary extra arguments" {
  run "$ILCLI" shell extra
  run "$ILCLI" build extra
  run "$ILCLI" down extra
  expect_log "$(start)" "$(argv docker compose -f "$COMPOSE" exec -it cc bash)" "$(argv docker compose -f "$COMPOSE" build)" "$(argv docker compose -f "$COMPOSE" down)"
}

# The developer's decision of 27 Sep 2026 (W2-R1-1): --help and -h after shell, build and down show their usage
# and run no docker, so that `down --help` does not stop the container.
@test "shell --help, build -h and down --help show their usage and make no docker call" {
  for call in "shell --help" "build -h" "down --help"; do
    run "$ILCLI" $call
    [ "$status" -eq 0 ]
    [[ "$output" == *"ilcli ${call%% *}"* ]] || { echo "$call: no usage"; echo "$output"; return 1; }
    [[ "$output" == *"Usage"* ]]
  done
  [ ! -s "$STUB_LOG" ]
}

# The developer's decision of 7 Oct 2026 (issue #88): the review command no longer exists, so a first word "review"
# reaches Claude Code like any word that is not a command.
@test "review is no command: it reaches claude with its arguments" {
  run "$ILCLI" review "a task" /p
  expect_log "$(start)" "$(claude review "a task" /p)"
}

@test "a failing 'up -d' shows its output, says so, exits 1 and runs no exec" {
  export STUB_DOCKER_FAIL=up
  run "$ILCLI" --continue
  [ "$status" -eq 1 ]
  [[ "$output" == *"stub: compose up failed"* ]]
  [[ "$output" == *"'docker compose up' failed"* ]]
  expect_log "$(start)"
}

# Issue #11: web starts the web server in the container, in the foreground; web.ts parses the port.
@test "web starts the container, then the web server on the default port" {
  run "$ILCLI" web
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(web_line)"
}

@test "web passes a port, and any other argument, to web.ts" {
  run "$ILCLI" web 9000
  run "$ILCLI" web 9000 extra
  expect_log "$(start)" "$(web_line 9000)" "$(start)" "$(web_line 9000 extra)"
}

@test "web --help and web -h show web's usage and make no docker call" {
  for flag in --help -h; do
    run "$ILCLI" web $flag
    [ "$status" -eq 0 ]
    [[ "$output" == *"ilcli web"* ]] || { echo "web $flag: no usage"; echo "$output"; return 1; }
    [[ "$output" == *"Usage"* ]]
  done
  [ ! -s "$STUB_LOG" ]
}

@test "a failing 'up -d' before web runs no exec" {
  export STUB_DOCKER_FAIL=up
  run "$ILCLI" web
  [ "$status" -eq 1 ]
  expect_log "$(start)"
}

# Issue #124 (the developer's decision of 9 Oct 2026): run, web and shell start their program in the container that
# is already running and never recreate it; a configuration that differs from the running container's gives a note
# on stderr, and the program still starts. A detection command that fails gives no note.

# program_line <command>: the exec line of run, web or shell with no arguments.
program_line() {
  case $1 in
    run) claude ;;
    web) web_line ;;
    shell) argv docker compose -f "$COMPOSE" exec -it cc bash ;;
  esac
}

no_recreation() {
  if grep -F '[up]' "$STUB_LOG" | grep -vF '[--no-recreate]'; then
    echo "an up without --no-recreate was issued"; return 1
  fi
  if grep -F '[--force-recreate]' "$STUB_LOG"; then
    echo "--force-recreate was issued"; return 1
  fi
}

expect_note() {
  local cmd=$1
  [[ $stderr == *"ilcli $cmd:"* ]] || { echo "no 'ilcli $cmd:' prefix in stderr: $stderr"; return 1; }
  for s in "older configuration" "bin/ilcli down" "Claude Code" "web server"; do
    [[ $stderr == *"$s"* ]] || { echo "stderr lacks '$s': $stderr"; return 1; }
  done
}

expect_no_note() {
  [[ $stderr != *"older configuration"* && $output != *"older configuration"* ]] || {
    echo "unexpected note: $stderr $output"; return 1; }
}

@test "run and web with no container: ps, up --no-recreate, the program, and no note" {
  for cmd in run web; do
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(start)" "$(program_line "$cmd")"
    expect_no_note
  done
}

@test "run and web with a container of the same configuration: no note, no recreation" {
  export STUB_CONTAINER_ID=abc STUB_RUNNING_HASH=h1 STUB_CONFIG_HASH=h1
  for cmd in run web; do
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(start_existing)" "$(program_line "$cmd")"
    expect_no_note
    no_recreation
  done
}

@test "run, web and shell with a container of an older configuration: the note on stderr, then the program" {
  export STUB_CONTAINER_ID=abc STUB_RUNNING_HASH=h1 STUB_CONFIG_HASH=h2
  for cmd in run web shell; do
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(start_existing)" "$(program_line "$cmd")"
    expect_note "$cmd"
    [[ $output != *"older configuration"* ]] || { echo "the note reached stdout"; return 1; }
    no_recreation
  done
}

@test "a detection command that fails gives no note, and the program starts" {
  export STUB_CONTAINER_ID=abc STUB_RUNNING_HASH=h1 STUB_CONFIG_HASH=h2
  for cmd in run web; do
    export STUB_DOCKER_FAIL=ps
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(ps_line)" "$(up)" "$(program_line "$cmd")"
    expect_no_note

    export STUB_DOCKER_FAIL=inspect
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(ps_line)" "$(inspect_line abc)" "$(up)" "$(program_line "$cmd")"
    expect_no_note

    export STUB_DOCKER_FAIL=config
    : > "$STUB_LOG"
    run --separate-stderr "$ILCLI" "$cmd"
    [ "$status" -eq 0 ]
    expect_log "$(start_existing)" "$(program_line "$cmd")"
    expect_no_note
  done
}

@test "a container without the hash label gives no note" {
  export STUB_CONTAINER_ID=abc STUB_CONFIG_HASH=h2
  run --separate-stderr "$ILCLI" web
  [ "$status" -eq 0 ]
  expect_log "$(ps_line)" "$(inspect_line abc)" "$(up)" "$(web_line)"
  expect_no_note
}
