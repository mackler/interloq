ensure_running web
forwarded_args web
exec docker compose -f "$(ilcli_root)/compose.cc.yaml" exec -it cc node /opt/interloq/src/web.ts "${forwarded[@]}"
