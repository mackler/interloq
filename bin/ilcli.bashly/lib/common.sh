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

# The mounts of a container (issue #172), one line 'host-source<TAB>container-destination' per mount, as
# 'docker inspect --format "$MOUNTS_TEMPLATE" <id>' prints them.
MOUNTS_TEMPLATE='{{range .Mounts}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}'

# is_launcher <pgrep line>: succeeds when the line's program, the word after the pid, is docker or
# docker-compose, by name or by path. A host-side 'docker compose ... exec cc node /opt/interloq/src/web.ts' names
# the copy in its arguments but runs nothing from it, so it never counts as a user of the copy.
is_launcher() {
  local pid program rest
  read -r pid program rest <<< "$1"
  [[ $program == docker || $program == docker-compose || $program == */docker || $program == */docker-compose ]]
}

# run_capturing <command>...: runs the command and sets run_out (its stdout), run_rc (its exit status),
# run_had_err (1 when its stderr was nonempty, empty otherwise) and run_err_line (the first line of its stderr that
# is not blank, for a message), whatever the status. Its stderr goes to a temporary file, removed on every path.
# Fails, running nothing, when that file cannot be created: its callers run in a condition, where errexit is off,
# so an unchecked mktemp would leave an empty path whose redirection fails silently with status 1, which a search
# would read as no match (W1-R1-1).
run_capturing() {
  local errfile
  run_out="" run_rc=0 run_err_line="" run_had_err=""
  errfile=$(mktemp) || return 1
  run_out=$("$@" 2>"$errfile") || run_rc=$?
  if [[ -s $errfile ]]; then run_had_err=1; fi
  run_err_line=$(grep -m 1 '[^[:space:]]' "$errfile" || true)
  rm -f "$errfile"
}

# exit_text: the status and the first stderr line that is not blank of the command run_capturing last ran, as one
# phrase.
exit_text() {
  printf '(exit status %s)%s' "$run_rc" "${run_err_line:+: $run_err_line}"
}

# ere_escape <text>: the text with every metacharacter of an extended regular expression escaped, so that pgrep -f
# matches it literally.
ere_escape() {
  sed 's/[][\\.*^$+?(){}|]/\\&/g' <<< "$1"
}

# copy_root_paths <root> <source> <destination>: the path at which a mount of <source> at <destination> shows the
# copy whose host root is <root>, or nothing. A source equal to the root shows it at the destination; a source
# above it at a path boundary shows it below the destination; a source inside it (a directory or a single file of
# the copy, such as the Codex binary) shows that part at the destination. Trailing slashes are stripped, so a
# source of / is above every root.
copy_root_paths() {
  local root=${1%/} source=${2%/} destination=${3%/}
  if [[ $source == "$root" || $source == "$root"/* ]]; then
    printf '%s\n' "${destination:-/}"
  elif [[ $root == "$source"/* ]]; then
    printf '%s\n' "$destination${root#"$source"}"
  fi
}

# copy_paths_in <id>: the paths at which container <id> sees the installed copy or a part of it, one per line, on
# stdout; empty when it mounts none of it. The copy's root is compared as given and resolved, since docker may
# record a bind mount's source as either. Fails with the reason on stdout when the mounts cannot be read, or a
# temporary file cannot be created for reading them.
copy_paths_in() {
  local given resolved root source destination path paths=""
  local -a roots
  run_capturing docker inspect --format "$MOUNTS_TEMPLATE" "$1" ||
    { echo "could not create a temporary file for reading its mounts"; return 1; }
  if [[ $run_rc -ne 0 ]]; then
    printf 'its mounts could not be read %s\n' "$(exit_text)"
    return 1
  fi
  given=$(ilcli_root)
  roots=("$given")
  if resolved=$(cd "$given" && pwd -P) && [[ $resolved != "$given" ]]; then roots+=("$resolved"); fi
  while IFS=$'\t' read -r source destination; do
    [[ -n $source ]] || continue
    for root in "${roots[@]}"; do
      path=$(copy_root_paths "$root" "$source" "$destination")
      if [[ -n $path && $'\n'$paths != *$'\n'$path$'\n'* ]]; then paths+=$path$'\n'; fi
    done
  done <<< "$run_out"
  printf '%s' "$paths"
}

# copy_pattern <path>...: what upgrade's search looks for in a process's command line: any of the paths, as a whole
# word (a mounted file executed by its path, or a directory named bare) or followed by '/' (anything below it),
# never as the start of a longer name. A '/' alone after each path would miss a mounted file executed by its exact
# path ('/usr/local/bin/codex exec'). It is unanchored at the start, because the path may follow interpreter
# options ('node --inspect /opt/interloq/...', 'env node /opt/interloq/...'); launchers are excluded by their
# program instead (is_launcher).
copy_pattern() {
  local path alternatives=()
  for path in "$@"; do
    alternatives+=("$(ere_escape "$path")(/|[[:space:]]|\$)")
  done
  local IFS='|'
  printf '(%s)\n' "${alternatives[*]}"
}

# search_container <id> <pattern>: the lines of the processes in container <id> whose command line matches
# <pattern>, launchers dropped, on stdout. Fails with the reason on stdout when the search cannot be made: pgrep
# exits 1 with nothing on stderr for no match, while docker exec also exits 1, with a message, for a container that
# is gone or not running, and 126 or 127 when pgrep is absent, so only a silent 1 means none; and a temporary file
# that cannot be created makes it inconclusive too. Silence is tested on the whole of stderr, not its first line,
# because a daemon's message may begin with an empty line, and an empty first line is not silence (W2-R1-1).
search_container() {
  local line
  run_capturing docker exec "$1" pgrep -a -f "$2" ||
    { echo "could not create a temporary file for the search"; return 1; }
  if [[ $run_rc -eq 1 && -z $run_had_err ]]; then return 0; fi
  if [[ $run_rc -eq 126 || $run_rc -eq 127 ]]; then
    printf 'the search failed %s: pgrep could not be run in the container, so its processes cannot be searched; installing procps in it, or stopping it once it runs nothing from the copy, lets the check pass\n' "$(exit_text)"
    return 1
  fi
  if [[ $run_rc -ne 0 ]]; then
    printf 'the search failed %s\n' "$(exit_text)"
    return 1
  fi
  while IFS= read -r line; do
    if [[ -n $line ]] && ! is_launcher "$line"; then printf '%s\n' "$line"; fi
  done <<< "$run_out"
}

# installed_copy_users: the report of the processes in running containers that use the installed copy, on stdout
# (empty for none), each container as 'name (id), the copy at <paths>:' with its lines. Only the containers that
# mount the copy are searched (issue #172), at the paths they mount it at, because a container that does not mount
# it cannot run it. Fails with the reason on stdout when the check cannot be made: docker missing, a temporary file
# that cannot be created, docker ps failing, a container whose mounts cannot be read (it might mount the copy), or a
# container that mounts the copy whose search fails. An inconclusive container ends the check, since upgrade changes
# nothing until every check has passed.
installed_copy_users() {
  local containers id name paths shown found report=""
  local -a path_list
  if ! command -v docker > /dev/null 2>&1; then
    echo "docker is not available"
    return 1
  fi
  run_capturing docker ps --format '{{.ID}} {{.Names}}' ||
    { echo "could not create a temporary file for docker ps"; return 1; }
  if [[ $run_rc -ne 0 ]]; then
    printf 'docker ps failed %s\n' "$(exit_text)"
    return 1
  fi
  containers=$run_out
  while read -r id name; do
    [[ -n $id ]] || continue
    if ! paths=$(copy_paths_in "$id"); then
      printf 'in container %s (%s), %s\n' "$name" "$id" "$paths"
      return 1
    fi
    [[ -n $paths ]] || continue
    mapfile -t path_list <<< "${paths%$'\n'}"
    shown=${paths%$'\n'}
    shown=${shown//$'\n'/, }
    if ! found=$(search_container "$id" "$(copy_pattern "${path_list[@]}")"); then
      printf 'in container %s (%s), which mounts the installed copy at %s, %s\n' "$name" "$id" "$shown" "$found"
      return 1
    fi
    if [[ -n $found ]]; then
      report+="$name ($id), the copy at $shown:"$'\n'"$(sed 's/^/  /' <<< "$found")"$'\n'
    fi
  done <<< "$containers"
  printf '%s' "$report"
}
