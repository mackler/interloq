ensure_running shell
exec docker compose -f "$(ilcli_root)/compose.cc.yaml" exec -it cc bash
