## bashly always handles --version and -v at the root; bin/dev-claude passed them to claude, so they go to run.
if [[ ${command_line_args[0]:-} == "--version" || ${command_line_args[0]:-} == "-v" ]]; then
  command_line_args=(run "${command_line_args[@]}")
fi
## The arguments as typed, for run and web (bashly drops a literal -- from its catch-all).
declare -g -a ilcli_argv=("${command_line_args[@]}")
