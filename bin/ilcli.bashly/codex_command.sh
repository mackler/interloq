[[ -x "$(ilcli_root)/$CODEX_RELATIVE_PATH" ]] ||
  refuse codex "the Codex CLI was not found at $(ilcli_root)/$CODEX_RELATIVE_PATH; npm ci in the development clone installs it"
ensure_running codex
forwarded_args codex
if implementation_in_progress; then
  note codex "an implementation run is in progress; a change to /workspace stops that run if it is made while Codex reviews for the run or while Claude Code writes or revises the run's plan."
fi
codex_resume_args
exec docker compose -f "$(compose_file)" exec -it cc "/workspace/$CODEX_RELATIVE_PATH" "${forwarded[@]}"
