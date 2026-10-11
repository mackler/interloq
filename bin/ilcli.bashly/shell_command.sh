ensure_running shell
exec docker compose -f "$(compose_file)" exec -it cc bash
