ensure_running run
forwarded_args run
exec docker compose -f "$(compose_file)" exec -it cc claude "${forwarded[@]}"
