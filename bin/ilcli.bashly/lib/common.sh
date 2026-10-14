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

# What upgrade's search looks for in a process's command line (issue #104): the path at which every project
# container mounts the installed copy. It is unanchored, because the path may follow interpreter options
# ('node --inspect /opt/interloq/...', 'env node /opt/interloq/...'); launchers are excluded by their program instead.
INSTALLED_COPY_PATTERN='/opt/interloq/'

# is_launcher <pgrep line>: succeeds when the line's program, the word after the pid, is docker or
# docker-compose, by name or by path. A host-side 'docker compose ... exec cc node /opt/interloq/src/web.ts' names
# the copy in its arguments but runs nothing from it, so it never counts as a user of the copy.
is_launcher() {
  local pid program rest
  read -r pid program rest <<< "$1"
  [[ $program == docker || $program == docker-compose || $program == */docker || $program == */docker-compose ]]
}

# exit_text <status> <stderr file>: a failed command's status and the first line of its stderr, as one phrase.
exit_text() {
  local err
  err=$(head -n 1 "$2")
  printf '(exit status %s)%s' "$1" "${err:+: $err}"
}

# search_container <id>: the lines of the processes in container <id> whose command line names the installed
# copy, launchers dropped, on stdout. Fails with the reason on stdout when the search cannot be made: pgrep exits
# 1 with nothing on stderr for no match, while docker exec also exits 1, with a message, for a container that is
# gone or not running, and 126 or 127 when pgrep is absent, so only a silent 1 means none. A temporary file that
# cannot be created fails it too: it runs in a condition, where errexit is off, so an unchecked mktemp would leave
# an empty path whose redirection fails silently with status 1, which would read as no match (W1-R1-1).
search_container() {
  local errfile rc=0 out reason="" line
  errfile=$(mktemp) || { echo "could not create a temporary file for the search"; return 1; }
  out=$(docker exec "$1" pgrep -a -f "$INSTALLED_COPY_PATTERN" 2>"$errfile") || rc=$?
  if [[ $rc -ne 0 && ! ($rc -eq 1 && ! -s $errfile) ]]; then reason="the search failed $(exit_text "$rc" "$errfile")"; fi
  rm -f "$errfile"
  if [[ -n $reason ]]; then
    printf '%s\n' "$reason"
    return 1
  fi
  if [[ $rc -ne 0 ]]; then return 0; fi
  while IFS= read -r line; do
    if [[ -n $line ]] && ! is_launcher "$line"; then printf '%s\n' "$line"; fi
  done <<< "$out"
}

# installed_copy_users: the report of the processes in running containers that use the installed copy, on stdout
# (empty for none), each container as 'name (id):' with its lines. Fails with the reason on stdout when the check
# cannot be made: docker missing, a temporary file that cannot be created, docker ps failing, or a container whose
# search fails. An inconclusive container ends the check, since upgrade changes nothing until every check has passed.
installed_copy_users() {
  local errfile rc=0 containers reason="" id name found report=""
  if ! command -v docker > /dev/null 2>&1; then
    echo "docker is not available"
    return 1
  fi
  errfile=$(mktemp) || { echo "could not create a temporary file for docker ps"; return 1; }
  containers=$(docker ps --format '{{.ID}} {{.Names}}' 2>"$errfile") || rc=$?
  if [[ $rc -ne 0 ]]; then reason="docker ps failed $(exit_text "$rc" "$errfile")"; fi
  rm -f "$errfile"
  if [[ -n $reason ]]; then
    printf '%s\n' "$reason"
    return 1
  fi
  while read -r id name; do
    [[ -n $id ]] || continue
    if ! found=$(search_container "$id"); then
      printf 'in container %s (%s), %s\n' "$name" "$id" "$found"
      return 1
    fi
    if [[ -n $found ]]; then
      report+="$name ($id):"$'\n'"$(sed 's/^/  /' <<< "$found")"$'\n'
    fi
  done <<< "$containers"
  printf '%s' "$report"
}
