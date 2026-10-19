## Publish main: push it to origin (GitHub), where CI runs npm test and the end-to-end tests and advances release only if both pass.
## Nothing is pushed unless every check passes.
root="$(ilcli_root)"
g() { git -C "$root" "$@"; }

changes="$(g status --porcelain)"
if [[ -n $changes ]]; then
  refuse release "the working tree of $root has uncommitted or untracked changes; commit or remove them first:" "$changes"
fi

branch="$(g branch --show-current)"
if [[ $branch != main ]]; then
  refuse release "on branch '$branch', not main; switch to main (git switch main) and merge your work there first."
fi

if ! g fetch -q origin main; then
  refuse release "could not fetch main from origin ($(g remote get-url origin)); nothing was pushed."
fi

if ! g merge-base --is-ancestor origin/main main; then
  read -r behind ahead < <(g rev-list --left-right --count origin/main...main)
  if [[ $ahead -eq 0 ]]; then
    state="is behind origin/main by $behind commit(s)"
  else
    state="has diverged from origin/main ($ahead local, $behind remote commit(s))"
  fi
  refuse release "main $state; integrate origin/main first (git pull --ff-only, or rebase), then run npm test and release again. Nothing was pushed."
fi

old="$(g rev-parse origin/main)"
new="$(g rev-parse main)"
if [[ $old == "$new" ]]; then
  say release "nothing to publish: origin/main is already at $(commit_line "$new")."
  exit 0
fi

if ! g push origin main; then
  printf 'ilcli release: git push failed (shown above); origin/main is still at %s.\n' "$(commit_line "$old")" >&2
  exit 1
fi

short="$(g rev-parse --short "$new")"
say release "pushed main to origin ($(g remote get-url origin)):"
g log --format='  %h %s' "$old..$new"
say release "CI now runs npm test and the end-to-end tests on $short. The release branch advances to $short only if both pass;"
say release "then run bin/ilcli upgrade in the installed copy on the host to install it."
