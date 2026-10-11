ensure_running web
forwarded_args web
exec docker compose -f "$(compose_file)" exec -it cc node /opt/interloq/src/web.ts "${forwarded[@]}"
