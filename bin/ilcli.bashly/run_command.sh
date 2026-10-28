ensure_running run
forwarded_args run
resume_args
exec docker compose -f "$(compose_file)" exec -it cc claude "${forwarded[@]}"
