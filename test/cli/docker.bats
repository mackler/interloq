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
# The session lookup run in the container before claude, its script taken from the generated script itself, so
# that the argument the test expects and the one bin/ilcli sends come from one source.
lookup_script() { sed -n "s/^SESSION_LOOKUP_SCRIPT='\\(.*\\)'\$/\\1/p" "$ILCLI"; }
lookup() { argv docker compose -f "$COMPOSE" exec -T cc sh -c "$(lookup_script)"; }
web_line() { argv docker compose -f "$COMPOSE" exec -it cc node /opt/interloq/src/web.ts "$@"; }

expect_log() {
  local expected
  expected="$(printf '%s\n' "$@")"
  [ "$(cat "$STUB_LOG")" = "$expected" ] || { echo "expected:"; echo "$expected"; echo "got:"; cat "$STUB_LOG"; return 1; }
}

# The developer's decision of 28 Oct 2026: a start resumes the most recent conversation of the container's
# working directory, and --new starts a fresh one. The lookup is the newest session file that holds a user
# message, since Claude Code's -c chose a stub of four records that held none.
@test "no arguments resumes the most recent conversation" {
  export STUB_SESSION_ID=23e19b38-30a7-4133-a818-487a24a1ca1f
  run "$ILCLI"
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(lookup)" "$(claude --resume 23e19b38-30a7-4133-a818-487a24a1ca1f)"
}

@test "no arguments with no earlier conversation starts a new one and says so" {
  run "$ILCLI"
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(lookup)" "$(claude)"
  [[ "$output" == *"no earlier conversation"* ]] || { echo "$output"; return 1; }
}

@test "--new starts a new conversation, makes no lookup and is not passed on" {
  export STUB_SESSION_ID=abc123
  run "$ILCLI" --new
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(claude)"
  [[ "$output" != *"no earlier conversation"* ]] || { echo "$output"; return 1; }
}

@test "--new keeps the other arguments, in order" {
  export STUB_SESSION_ID=abc123
  run "$ILCLI" --new --model opus
  run "$ILCLI" run --model opus --new
  expect_log "$(start)" "$(claude --model opus)" "$(start)" "$(claude --model opus)"
}

@test "an argument that does not name a session still resumes" {
  export STUB_SESSION_ID=b6080b04-1b3f-4c2e-9a77-2f1d6c5e8a90
  run "$ILCLI" --model opus
  expect_log "$(start)" "$(lookup)" "$(claude --resume b6080b04-1b3f-4c2e-9a77-2f1d6c5e8a90 --model opus)"
}

# A lookup whose answer is not a session id, as a changed layout or a failing shell would give, starts a new
# conversation and passes nothing to claude.
@test "an answer that is not a session id starts a new conversation" {
  export STUB_SESSION_ID="sh: 1: cannot open /home/node/.claude/projects"
  run "$ILCLI"
  [ "$status" -eq 0 ]
  expect_log "$(start)" "$(lookup)" "$(claude)"
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
  expect_log "$(start)" "$(lookup)" "$(claude -abc --model=opus)" "$(start)" "$(claude -p "two words")"
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
  expect_log "$(start)" "$(lookup)" "$(claude review "a task" /p)"
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

# program_line <command>: the exec line of run, web or shell with no arguments; run looks the most recent
# conversation up first, and with no STUB_SESSION_ID set finds none and starts a new conversation.
program_line() {
  case $1 in
    run) lookup; claude ;;
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

# Issue #210: bin/ilcli codex opens an interactive Codex session in /workspace. Its calls are made over a copy of the
# script in a clone of its own (codex_clone), whose Codex binary a test creates or leaves out. Every script and path
# the expected lines carry is read from the generated script, so the test and the command take them from one source.

script_of() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$ILCLI"; }
clone_start() { argv docker compose -f "$CLONE_COMPOSE" ps -a -q cc; argv docker compose -f "$CLONE_COMPOSE" up -d --no-recreate; }
clone_start_existing() {
  argv docker compose -f "$CLONE_COMPOSE" ps -a -q cc; inspect_line abc
  argv docker compose -f "$CLONE_COMPOSE" config --hash cc; argv docker compose -f "$CLONE_COMPOSE" up -d --no-recreate
}
run_check() { argv docker compose -f "$CLONE_COMPOSE" exec -T cc node -e "$(script_of RUN_CHECK_SCRIPT)" 8090; }
codex_lookup() { argv docker compose -f "$CLONE_COMPOSE" exec -T cc sh -c "$(script_of CODEX_SESSION_LOOKUP_SCRIPT)"; }
codex_line() { argv docker compose -f "$CLONE_COMPOSE" exec -it cc "/workspace/$(codex_relative_path)" "$@"; }
CODEX_ID=01a0b89b-aac1-7130-a5b6-a35d12274425

codex_setup() { codex_clone; codex_binary; }

# Decision Q2: a start with no arguments reopens the newest interactive Codex conversation of /workspace.
@test "codex with no arguments resumes the conversation the lookup finds" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  run "$CLONE_ILCLI" codex
  [ "$status" -eq 0 ]
  expect_log "$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID)"
}

@test "codex with no earlier conversation, or an answer that is not a session id, starts a new one and says so" {
  codex_setup
  for answer in "" "sh: 1: cannot open /home/node/.codex/sessions"; do
    if [[ -n $answer ]]; then export STUB_SESSION_ID=$answer; else unset STUB_SESSION_ID; fi
    : > "$STUB_LOG"
    run --separate-stderr "$CLONE_ILCLI" codex
    [ "$status" -eq 0 ]
    expect_log "$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line)"
    [[ $stderr == *"ilcli codex:"*"no earlier conversation"* ]] || { echo "stderr: $stderr"; return 1; }
  done
}

@test "codex --new starts a new conversation, makes no lookup and is not passed on; other arguments kept in order" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  run "$CLONE_ILCLI" codex --new
  run "$CLONE_ILCLI" codex --new --model o3
  run "$CLONE_ILCLI" codex --model o3 --new
  expect_log "$(clone_start)" "$(run_check)" "$(codex_line)" \
    "$(clone_start)" "$(run_check)" "$(codex_line --model o3)" \
    "$(clone_start)" "$(run_check)" "$(codex_line --model o3)"
}

# Plan review P1-R1-1: a --new after a literal -- is Codex's argument.
@test "codex: --new after a literal -- is passed on, and one before it is removed" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  run "$CLONE_ILCLI" codex -- --new
  run "$CLONE_ILCLI" codex --new -- x
  expect_log "$(clone_start)" "$(run_check)" "$(codex_line -- --new)" \
    "$(clone_start)" "$(run_check)" "$(codex_line -- x)"
}

@test "codex: arguments that do not name a session still resume, a prompt staying one argument" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  run "$CLONE_ILCLI" codex --model o3
  run "$CLONE_ILCLI" codex "two words"
  expect_log "$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID --model o3)" \
    "$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID "two words")"
}

@test "codex: a subcommand, a version flag or a literal -- is left to Codex untouched, with no lookup" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  local expected=()
  for call in "exec|x y" "resume" "login" "--version" "-V" "--|--help" "a|--|b"; do
    IFS='|' read -r -a words <<< "$call"
    run "$CLONE_ILCLI" codex "${words[@]}"
    [ "$status" -eq 0 ]
    expected+=("$(clone_start)" "$(run_check)" "$(codex_line "${words[@]}")")
  done
  expect_log "${expected[@]}"
}

# Plan review P1-R1-1 of this run: Codex takes its options before a subcommand, and an option's value spelled like
# a subcommand is not one.
@test "codex: a subcommand after Codex's own options is left untouched, an option's value is not a subcommand" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  local expected=()
  for call in "--model|o3|exec|x" "-c|k=v|resume" "--model=o3|exec|x"; do
    IFS='|' read -r -a words <<< "$call"
    run "$CLONE_ILCLI" codex "${words[@]}"
    [ "$status" -eq 0 ]
    expected+=("$(clone_start)" "$(run_check)" "$(codex_line "${words[@]}")")
  done
  run "$CLONE_ILCLI" codex --model exec
  expected+=("$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID --model exec)")
  run "$CLONE_ILCLI" codex --model exec "two words"
  expected+=("$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID --model exec "two words")")
  expect_log "${expected[@]}"
}

# Decision Q3: the command adds no sandbox or approval setting.
@test "codex passes no sandbox or approval setting" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  run "$CLONE_ILCLI" codex
  run "$CLONE_ILCLI" codex --model o3
  [ "$(grep -cF "[/workspace/$(codex_relative_path)]" "$STUB_LOG")" -eq 2 ]
  for setting in --sandbox -s --ask-for-approval -a --full-auto --dangerously-bypass-approvals-and-sandbox; do
    if grep -F "[/workspace/$(codex_relative_path)]" "$STUB_LOG" | grep -F "[$setting]"; then echo "codex passed $setting"; return 1; fi
  done
}

# Decision Q4: a reminder on stderr only while the web server reports an implementation run in progress.
@test "codex reminds of an implementation run in progress on stderr, and still starts" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID STUB_RUN_CHECK=implementation
  run --separate-stderr "$CLONE_ILCLI" codex
  [ "$status" -eq 0 ]
  expect_log "$(clone_start)" "$(run_check)" "$(codex_lookup)" "$(codex_line resume $CODEX_ID)"
  [[ $stderr == *"ilcli codex:"*"implementation run is in progress"*"/workspace"* ]] || { echo "stderr: $stderr"; return 1; }
  [[ $output != *"implementation run"* ]] || { echo "the reminder reached stdout"; return 1; }
}

@test "codex gives no reminder when the check finds no run or answers anything else" {
  codex_setup
  export STUB_SESSION_ID=$CODEX_ID
  for answer in "" garbage; do
    if [[ -n $answer ]]; then export STUB_RUN_CHECK=$answer; else unset STUB_RUN_CHECK; fi
    run --separate-stderr "$CLONE_ILCLI" codex
    [ "$status" -eq 0 ]
    [[ $stderr != *"implementation run"* && $output != *"implementation run"* ]] || { echo "$stderr $output"; return 1; }
  done
}

# Decision Q1: the binary is the clone's; without it nothing runs.
@test "codex without the clone's Codex binary refuses, naming it and npm ci, and runs no docker" {
  codex_clone
  run --separate-stderr "$CLONE_ILCLI" codex
  [ "$status" -eq 1 ]
  [[ $stderr == *"ilcli codex:"*"$(codex_relative_path)"*"npm ci"* ]] || { echo "stderr: $stderr"; return 1; }
  [ ! -s "$STUB_LOG" ]
}

@test "codex --help and codex -h show its usage and make no docker call" {
  codex_setup
  for flag in --help -h; do
    run "$CLONE_ILCLI" codex $flag
    [ "$status" -eq 0 ]
    [[ "$output" == *"ilcli codex"* ]] || { echo "codex $flag: no usage"; echo "$output"; return 1; }
    [[ "$output" == *"Usage"* ]]
  done
  [ ! -s "$STUB_LOG" ]
}

@test "run codex still gives Claude Code the word" {
  run "$ILCLI" run codex
  expect_log "$(start)" "$(lookup)" "$(claude codex)"
}

@test "a failing 'up -d' before codex runs no exec" {
  codex_setup
  export STUB_DOCKER_FAIL=up
  run "$CLONE_ILCLI" codex
  [ "$status" -eq 1 ]
  expect_log "$(clone_start)"
}

@test "codex with a container of an older configuration: the note on stderr, then Codex" {
  codex_setup
  export STUB_CONTAINER_ID=abc STUB_RUNNING_HASH=h1 STUB_CONFIG_HASH=h2
  run --separate-stderr "$CLONE_ILCLI" codex
  [ "$status" -eq 0 ]
  expect_log "$(clone_start_existing)" "$(run_check)" "$(codex_lookup)" "$(codex_line)"
  expect_note codex
  no_recreation
}

# The lookup itself, run without docker over session files whose first lines copy those of Codex 0.155.1 (read
# from the container's ~/.codex/sessions on 1 Nov 2026): an interactive session has "source":"cli", one an Interloq
# run started through the SDK "source":"exec" and the SDK's originator.
meta_line() { printf '{"timestamp":"2026-11-01T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"%s","id":"%s","cwd":"%s","originator":"%s","cli_version":"0.155.1","source":"%s"}}\n' "$1" "$1" "$2" "$3" "$4"; }
session_file() {
  local dir="$T/home/.codex/sessions/2026/11/01" f
  mkdir -p "$dir"
  f="$dir/rollout-2026-11-01T10-00-00-$1.jsonl"
  meta_line "$1" "$2" "$3" "$4" > "$f"
  printf '{"type":"event_msg"}\n' >> "$f"
  touch -d "$5" "$f"
}

@test "the codex lookup picks the newest interactive session of /workspace, skipping the runs' and other directories'" {
  local older=01a0b89b-aac1-7130-a5b6-a35d12274425
  session_file "$older" /workspace codex-tui cli "2026-11-01 10:00"
  session_file 01a13539-ea59-7de2-910b-00ef13fa9b45 /workspace codex_sdk_ts exec "2026-11-01 11:00"
  session_file 01a19884-e7ab-7862-b855-f560443e3f7e /workspace/scratch codex-tui cli "2026-11-01 12:00"
  local script
  script=$(script_of CODEX_SESSION_LOOKUP_SCRIPT)
  [[ -n $script ]] || { echo "bin/ilcli holds no CODEX_SESSION_LOOKUP_SCRIPT"; return 1; }
  run env HOME="$T/home" sh -c "$script"
  [ "$status" -eq 0 ]
  [ "$output" = "$older" ] || { echo "got: $output"; return 1; }
}

@test "the codex lookup prints nothing and succeeds with no sessions or no matching one" {
  local script
  script=$(script_of CODEX_SESSION_LOOKUP_SCRIPT)
  [[ -n $script ]] || { echo "bin/ilcli holds no CODEX_SESSION_LOOKUP_SCRIPT"; return 1; }
  run env HOME="$T/home" sh -c "$script"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  session_file 01a13539-ea59-7de2-910b-00ef13fa9b45 /workspace codex_sdk_ts exec "2026-11-01 11:00"
  run env HOME="$T/home" sh -c "$script"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
