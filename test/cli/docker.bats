#!/usr/bin/env bats
# The docker commands of bin/ilcli pass exactly what bin/dev-claude passed to docker compose (stubbed).

load helpers

setup() { common_setup; }

up() { argv docker compose -f "$COMPOSE" up -d; }
claude() { argv docker compose -f "$COMPOSE" exec -it cc claude "$@"; }
review_line() { argv docker compose -f "$COMPOSE" exec -it cc node /opt/interloq/src/main.ts "$@"; }
web_line() { argv docker compose -f "$COMPOSE" exec -it cc node /opt/interloq/src/web.ts "$@"; }

expect_log() {
  local expected
  expected="$(printf '%s\n' "$@")"
  [ "$(cat "$STUB_LOG")" = "$expected" ] || { echo "expected:"; echo "$expected"; echo "got:"; cat "$STUB_LOG"; return 1; }
}

@test "no arguments starts the container, then claude" {
  run "$ILCLI"
  [ "$status" -eq 0 ]
  expect_log "$(up)" "$(claude)"
}

@test "an unknown first argument goes to claude" {
  run "$ILCLI" --continue
  expect_log "$(up)" "$(claude --continue)"
}

# The developer's decision of 7 Oct 2026 (issue #10), which replaced the narrower one of 27 Sep 2026: --help and -h
# after every subcommand, run and review included, show its usage; -- passes the rest on.
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
  expect_log "$(up)" "$(claude --continue)" "$(up)" "$(claude -c)" "$(up)" "$(claude -c)" "$(up)" "$(claude --continue)"
}

@test "run --resume reaches claude" {
  run "$ILCLI" run --resume
  expect_log "$(up)" "$(claude --resume)"
}

@test "arguments pass through without splitting, in order" {
  run "$ILCLI" -abc --model=opus
  run "$ILCLI" run -p "two words"
  expect_log "$(up)" "$(claude -abc --model=opus)" "$(up)" "$(claude -p "two words")"
}

@test "--version and -v as the first argument reach claude" {
  run "$ILCLI" --version
  run "$ILCLI" -v
  expect_log "$(up)" "$(claude --version)" "$(up)" "$(claude -v)"
}

@test "a literal -- is kept, element by element" {
  run "$ILCLI" run -- --help
  run "$ILCLI" -- --help
  run "$ILCLI" run a -- b
  expect_log "$(up)" "$(claude -- --help)" "$(up)" "$(claude -- --help)" "$(up)" "$(claude a -- b)"
}

@test "shell opens bash" {
  run "$ILCLI" shell
  expect_log "$(up)" "$(argv docker compose -f "$COMPOSE" exec -it cc bash)"
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
  expect_log "$(up)" "$(argv docker compose -f "$COMPOSE" exec -it cc bash)" "$(argv docker compose -f "$COMPOSE" build)" "$(argv docker compose -f "$COMPOSE" down)"
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

@test "review passes its arguments to main.ts, one with a space kept whole" {
  run "$ILCLI" review "a task" /p
  expect_log "$(up)" "$(review_line "a task" /p)"
}

@test "review --help and review -h show review's usage and make no docker call" {
  for flag in --help -h; do
    run "$ILCLI" review $flag
    [ "$status" -eq 0 ]
    [[ "$output" == *"ilcli review"* ]] || { echo "review $flag: no usage"; echo "$output"; return 1; }
    [[ "$output" == *"Usage"* ]]
  done
  [ ! -s "$STUB_LOG" ]
}

@test "review -- --help reaches main.ts, and review -- keeps the --" {
  run "$ILCLI" review -- --help
  run "$ILCLI" review -- /p
  expect_log "$(up)" "$(review_line -- --help)" "$(up)" "$(review_line -- /p)"
}

@test "a failing 'up -d' shows its output, says so, exits 1 and runs no exec" {
  export STUB_DOCKER_FAIL=up
  run "$ILCLI" --continue
  [ "$status" -eq 1 ]
  [[ "$output" == *"stub: compose up failed"* ]]
  [[ "$output" == *"'docker compose up' failed"* ]]
  expect_log "$(up)"
}

# Issue #11: web starts the web server in the container, in the foreground; web.ts parses the port.
@test "web starts the container, then the web server on the default port" {
  run "$ILCLI" web
  [ "$status" -eq 0 ]
  expect_log "$(up)" "$(web_line)"
}

@test "web passes a port, and any other argument, to web.ts" {
  run "$ILCLI" web 9000
  run "$ILCLI" web 9000 extra
  expect_log "$(up)" "$(web_line 9000)" "$(up)" "$(web_line 9000 extra)"
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
  expect_log "$(up)"
}
