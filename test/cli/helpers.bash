# Shared fixtures of the bin/ilcli tests: stubs of docker and npm first on PATH, and temporary git repositories
# (a bare origin, a development clone on main, an installed clone on release) that carry a copy of bin/ilcli.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
ILCLI="$REPO_ROOT/bin/ilcli"
COMPOSE="$REPO_ROOT/compose.cc.yaml"

common_setup() {
  T="$BATS_TEST_TMPDIR"
  export STUB_LOG="$T/stub.log"
  : > "$STUB_LOG"
  export PATH="$REPO_ROOT/test/cli/stubs:$PATH"
  export HOME="$T/home"
  mkdir -p "$HOME"
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
  unset STUB_DOCKER_FAIL STUB_NPM_FAIL STUB_CONTAINER_ID STUB_RUNNING_HASH STUB_CONFIG_HASH STUB_DOCKER_PS STUB_DOCKER_EXEC STUB_MKTEMP_FAIL_AFTER
}

# The expected log line of a stub call: the command, then each argument in brackets.
argv() {
  local line="$1"
  shift
  for a in "$@"; do line+=" [$a]"; done
  printf '%s\n' "$line"
}

# origin.git with main and release at one initial commit, and a helper clone "$T/other" to advance them.
make_origin() {
  git init -q -b main "$T/seed"
  mkdir -p "$T/seed/bin"
  cp "$ILCLI" "$T/seed/bin/ilcli"
  printf 'node_modules/\nweb/dist/\n' > "$T/seed/.gitignore"
  printf '{"lockfileVersion": 3}\n' > "$T/seed/package-lock.json"
  git -C "$T/seed" add -A
  git -C "$T/seed" commit -q -m "initial"
  git init -q --bare -b main "$T/origin.git"
  git -C "$T/seed" push -q "$T/origin.git" main main:release
  git clone -q "$T/origin.git" "$T/other"
}

# advance <branch> <subject>: a new commit on origin's branch, made from the helper clone.
advance() {
  git -C "$T/other" fetch -q origin
  git -C "$T/other" checkout -q -B "$1" "origin/$1"
  printf '%s\n' "$2" >> "$T/other/changes.txt"
  git -C "$T/other" add -A
  git -C "$T/other" commit -q -m "$2"
  git -C "$T/other" push -q origin "$1"
}

# commit_in <clone> <subject>: a local commit in a clone, not pushed.
commit_in() {
  printf '%s\n' "$2" >> "$1/local.txt"
  git -C "$1" add -A
  git -C "$1" commit -q -m "$2"
}

clone_dev() { git clone -q "$T/origin.git" "$T/dev"; }
clone_installed() { git clone -q -b release "$T/origin.git" "$T/installed"; }
head_of() { git -C "$1" rev-parse "${2:-HEAD}"; }

# container_procs <id> <line>...: the processes `docker exec <id> pgrep …` searches, each line `pid cmdline`.
container_procs() {
  local id="$1"
  shift
  mkdir -p "$T/exec"
  printf '%s\n' "$@" > "$T/exec/$id.procs"
  export STUB_DOCKER_EXEC="$T/exec"
}

# container_fails <id> <status> <stderr>: `docker exec <id> …` prints <stderr> and exits with <status>.
container_fails() {
  mkdir -p "$T/exec"
  printf '%s\n' "$2" > "$T/exec/$1.status"
  printf '%s\n' "$3" > "$T/exec/$1.err"
  export STUB_DOCKER_EXEC="$T/exec"
}

# path_without_docker: PATH becomes one directory of links to every executable on PATH except docker (the first
# occurrence of each name, the stubs first), so that docker is missing even where the machine has it.
path_without_docker() {
  local dir name f
  mkdir -p "$T/nodocker"
  local IFS=:
  for dir in $PATH; do
    [[ -d $dir ]] || continue
    for f in "$dir"/*; do
      name="${f##*/}"
      if [[ $name != docker && -x $f && ! -d $f && ! -e $T/nodocker/$name && ! -L $T/nodocker/$name ]]; then
        ln -s "$f" "$T/nodocker/$name"
      fi
    done
  done
  export PATH="$T/nodocker"
}
