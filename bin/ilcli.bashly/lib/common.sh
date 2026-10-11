## The shared functions of bin/ilcli.

# The root of the clone that contains this script.
ilcli_root() (
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
)

# compose.cc.yaml of that clone.
compose_file() {
  printf '%s\n' "$(ilcli_root)/compose.cc.yaml"
}

# docker compose over compose_file, as bin/dev-claude called it. The commands that end in a program use
# 'exec docker compose -f "$(compose_file)" ...' instead, since exec needs a program, not a function.
ilcli_compose() {
  docker compose -f "$(compose_file)" "$@"
}

# The hash docker compose records on a container it created: the hash of the service's configuration as resolved
# then, in the shell that created it.
CONFIG_HASH_TEMPLATE='{{index .Config.Labels "com.docker.compose.config-hash"}}'

# Succeeds only when a container of the service exists and its recorded configuration hash differs from the one
# compose.cc.yaml resolves to in this shell. Bare names in its environment: list take their values from the
# invoking shell, so a shell whose credential variables differ from the creating shell's resolves differently.
# Every command's output is used only after its exit status was checked; a command that fails, or an empty or
# malformed answer, means no difference is known.
config_is_stale() {
  local id running line wanted
  if ! id=$(ilcli_compose ps -a -q cc 2>/dev/null) || [[ -z $id ]]; then return 1; fi
  if ! running=$(docker inspect --format "$CONFIG_HASH_TEMPLATE" "$id" 2>/dev/null) || [[ -z $running ]]; then
    return 1
  fi
  if ! line=$(ilcli_compose config --hash cc 2>/dev/null); then return 1; fi
  wanted=${line#* }
  [[ -n $wanted && $wanted != "$line" && $wanted != "$running" ]]
}

# ensure_running <command>: creates the container only when none exists and never recreates one
# ('up -d --no-recreate'; a stopped container is started as it is), and the programs are started with
# 'docker compose exec', which never recreates either. So run, web and shell, started from shells whose
# variables differ, do not stop each other's programs. The container's credentials are those of the shell that
# created it. A shell whose configuration differs gets a note on stderr and changes nothing; 'bin/ilcli down',
# then a start, applies the new configuration. The output of 'up' is held back so that it does not interfere
# with the interactive session, and shown only on failure.
ensure_running() {
  local output
  if config_is_stale; then
    note "$1" "the container was created with an older configuration than compose.cc.yaml gives in this shell (its file, or the credential variables this shell sets, differ); it is used as it is."
    note "$1" "bin/ilcli down, then bin/ilcli run, web or shell, applies the new configuration; bin/ilcli down stops Claude Code and the web server running in the container."
  fi
  if ! output=$(ilcli_compose up -d --no-recreate 2>&1); then
    printf '%s\n' "$output" >&2
    echo "ilcli: 'docker compose up' failed" >&2
    exit 1
  fi
}

# The arguments as the user typed them (saved by initialize.sh before bashly parses them), without the
# command's own name when it was given: bashly drops a literal -- from its catch-all, this keeps it.
forwarded_args() {
  forwarded=("${ilcli_argv[@]}")
  if [[ ${forwarded[0]:-} == "$1" ]]; then
    forwarded=("${forwarded[@]:1}")
  fi
}

# say <command> <text>: a line of progress; note below; refuse <command> <text> [details]: the reason on stderr, exit 1.
say() {
  printf 'ilcli %s: %s\n' "$1" "$2"
}

# note <command> <text>: a line the user must see that is not the command's output, on stderr.
note() {
  printf 'ilcli %s: %s\n' "$1" "$2" >&2
}

refuse() {
  printf 'ilcli %s: refused: %s\n' "$1" "$2" >&2
  if [[ -n ${3:-} ]]; then
    printf '%s\n' "$3" | sed 's/^/  /' >&2
  fi
  exit 1
}

# The short hash and subject of a commit.
commit_line() {
  git -C "$(ilcli_root)" log -1 --format='%h %s' "$1"
}
