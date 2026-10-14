## Bring the installed copy (the clone containing this script) to origin/release, then npm ci and npm run build.
## Nothing is changed before every check has passed.
root="$(ilcli_root)"
g() { git -C "$root" "$@"; }

changes="$(g status --porcelain)"
if [[ -n $changes ]]; then
  refuse upgrade "local modifications in $root; the installed copy must match a tested commit. Remove or stash them first:" "$changes"
fi

branch="$(g branch --show-current)"
if [[ $branch != release ]]; then
  refuse upgrade "on branch '$branch', not release. The installed copy follows release, which only CI advances (see the README, \"Switching the installed copy to release\")."
fi

upstream="$(g rev-parse --abbrev-ref 'release@{upstream}' 2>/dev/null || true)"
if [[ $upstream != origin/release ]]; then
  refuse upgrade "branch release does not track origin/release (it tracks '${upstream:-nothing}'). Set it with: git branch --set-upstream-to=origin/release release"
fi

## Issue #104: before the fetch, so that a refusal leaves the copy as it was; refusing after the fast-forward but
## before npm ci would leave it at a commit whose dependencies are not installed.
force_hint="bin/ilcli upgrade --force skips the check and replaces the copy anyway."
if [[ -n ${args[--force]:-} ]]; then
  note upgrade "--force: the check for processes using the installed copy was skipped."
elif ! users="$(installed_copy_users)"; then
  refuse upgrade "could not check whether the installed copy is in use: $users. Nothing was changed. $force_hint"
elif [[ -n $users ]]; then
  refuse upgrade "processes in running containers run files under /opt/interloq, the installed copy ($root). Replacing those files can kill a running agent at any later point until its run ends, not only during the update. Nothing was changed. $force_hint" "$users"
fi

url="$(g remote get-url origin)"
if ! g fetch -q origin release; then
  refuse upgrade "could not fetch release from origin ($url); nothing was changed."
fi

local_only="$(g log --format='%h %s' origin/release..release)"
if [[ -n $local_only ]]; then
  refuse upgrade "release has commits that origin/release does not have, so the installed copy would not be a tested commit. Nothing was reset or discarded; move them elsewhere by hand:" "$local_only"
fi

old="$(g rev-parse HEAD)"
g merge -q --ff-only origin/release
new="$(g rev-parse HEAD)"
say upgrade "fetched release from $url."
if [[ $old == "$new" ]]; then
  say upgrade "already at $(commit_line "$new")."
else
  say upgrade "moved from $(commit_line "$old")"
  say upgrade "        to $(commit_line "$new") ($(g rev-list --count "$old..$new") commit(s))."
fi

short="$(g rev-parse --short HEAD)"
if ! (cd "$root" && npm ci); then
  printf 'ilcli upgrade: npm ci failed. The copy is now at %s; run bin/ilcli upgrade again to repeat the install and the build.\n' "$short" >&2
  exit 1
fi
say upgrade "npm ci: done."
if ! (cd "$root" && npm run build); then
  printf 'ilcli upgrade: npm run build failed. The copy is now at %s; run bin/ilcli upgrade again to repeat the install and the build.\n' "$short" >&2
  exit 1
fi
say upgrade "npm run build: done."
say upgrade "now at $(commit_line HEAD)."
say upgrade "next: restart the web server (Ctrl+C, then node /opt/interloq/src/web.ts) and reload every open tab."
