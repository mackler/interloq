#!/usr/bin/env bats
# The usage text of bin/ilcli documents every command, and asking for it calls no docker.

load helpers

setup() { common_setup; }

@test "help, -h and --help list every command and call no docker" {
  for form in help -h --help; do
    run "$ILCLI" $form
    [ "$status" -eq 0 ]
    for command in run shell web build down release upgrade help; do
      [[ "$output" == *"  $command "* ]] || { echo "'$form' does not list $command"; echo "$output"; return 1; }
    done
  done
  [ ! -s "$STUB_LOG" ]
}

@test "help run prints run's own usage, which names Claude Code" {
  run "$ILCLI" help run
  [ "$status" -eq 0 ]
  [[ "$output" == *"ilcli run"* ]]
  [[ "$output" == *"Claude Code"* ]]
  [ ! -s "$STUB_LOG" ]
}

# Issue #88: the terminal interface is gone, and with it the review command (the developer's decision of 7 Oct 2026).
@test "help lists no review command, and help review is refused as an unknown command" {
  run "$ILCLI" help
  [ "$status" -eq 0 ]
  [[ "$output" != *"  review "* ]] || { echo "$output"; return 1; }
  [[ "$output" != *"main.ts"* ]] || { echo "$output"; return 1; }
  run "$ILCLI" help review
  [ "$status" -ne 0 ]
  [ ! -s "$STUB_LOG" ]
}

@test "help web documents web, its port, and the recreate" {
  run "$ILCLI" help web
  [ "$status" -eq 0 ]
  local text
  text="$(printf '%s' "$output" | tr -s ' \n' '  ')"
  for word in "ilcli web" /opt/interloq/src/web.ts 8090 compose.cc.yaml recreated; do
    [[ "$text" == *"$word"* ]] || { echo "help web lacks $word"; echo "$output"; return 1; }
  done
  [ ! -s "$STUB_LOG" ]
}

@test "help shell prints shell's usage and makes no docker call" {
  run "$ILCLI" help shell
  [ "$status" -eq 0 ]
  [[ "$output" == *"ilcli shell"* ]]
  [ ! -s "$STUB_LOG" ]
}

# The developer's decision of 7 Oct 2026 (issue #10), replacing the narrower one of 27 Sep 2026: --help and -h after
# every subcommand show its usage, and -- passes the rest on to the program that run starts.
@test "every subcommand's usage offers --help, and run says that -- passes the rest on" {
  for command in run shell web build down; do
    run "$ILCLI" help "$command"
    [[ "$output" == *"ilcli $command --help | -h"* ]] || { echo "help $command"; echo "$output"; return 1; }
    [[ "$output" != *"are passed to claude"* && "$output" != *"are passed to main.ts"* ]] || { echo "help $command"; echo "$output"; return 1; }
  done
  run "$ILCLI" help run
  [[ "$output" == *"-- passes the rest on to claude"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"-c, --continue"*"most recent session"* ]] || { echo "$output"; return 1; }
  run "$ILCLI" --help
  # bashly wraps the text at 80 columns, so it is compared with its line breaks and indentation collapsed.
  local text
  text="$(printf '%s' "$output" | tr -s ' \n' '  ')"
  [[ "$text" == *"--help and -h show that command's usage"* ]] || { echo "$output"; return 1; }
  [[ "$text" == *"-- passes the rest on"* ]] || { echo "$output"; return 1; }
  [[ "$text" != *"are not ilcli's"* ]]
  [ ! -s "$STUB_LOG" ]
}
