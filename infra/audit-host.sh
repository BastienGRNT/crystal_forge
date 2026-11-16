#!/usr/bin/env bash
# =============================================================================
# audit-host.sh — Audit de l'hôte Proxmox, en LECTURE SEULE
# -----------------------------------------------------------------------------
# Relève la mémoire, le swap, l'ARC ZFS, le stockage, la pression (PSI), les OOM
# récents et, pour chaque CT : sa config, sa consommation cgroup réelle
# (memory.current/peak, compteurs oom_kill) et, s'il tourne, l'état Docker.
#
# Ne modifie RIEN : aucune commande d'écriture, aucun démarrage ni arrêt de CT.
# Les seules commandes lancées DANS les CT (pct exec) sont des lectures :
# docker info / docker stats --no-stream / ps / free / df.
# Les lignes « description: » des configs (texte libre) sont masquées.
#
# Usage (sur l'hôte, en root) :  bash audit-host.sh
# Résultat : /root/forge-audit-AAAAMMJJ-HHMM.txt — relisez-le avant de le partager.
# =============================================================================
set -u

OUT="/root/forge-audit-$(date +%Y%m%d-%H%M).txt"
exec > >(tee "$OUT") 2>&1

sec() { printf '\n===== %s =====\n' "$*"; }
cmd() { printf '\n$ %s\n' "$*"; timeout 30 "$@" 2>&1 || printf '(code %s)\n' "$?"; }

sec "Hôte"
cmd pveversion
cmd uptime
cmd nproc
cmd free -m
cmd swapon --show
cmd cat /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io
cmd sysctl vm.swappiness vm.overcommit_memory vm.min_free_kbytes
cmd lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
cmd cat /sys/kernel/mm/ksm/run /sys/kernel/mm/ksm/pages_sharing
[[ -d /sys/block/zram0 ]] && cmd zramctl

sec "ZFS / ARC"
if [[ -r /proc/spl/kstat/zfs/arcstats ]]; then
	awk '$1 ~ /^(size|c_max|c_min|c)$/ {printf "%-6s %8.0f Mo\n", $1, $3/1048576}' /proc/spl/kstat/zfs/arcstats
	cmd cat /sys/module/zfs/parameters/zfs_arc_max
	cmd zpool list
else
	echo "Pas de ZFS"
fi

sec "Stockage"
cmd df -hT -x tmpfs -x devtmpfs -x overlay
cmd pvesm status
command -v lvs >/dev/null && cmd lvs
cmd du -sh /var/lib/vz/images /var/lib/vz/dump /var/lib/vz/template

sec "Processus de l'hôte les plus gourmands (RSS)"
ps -eo pid,rss,comm --sort=-rss | head -15 | awk 'NR==1{print;next}{printf "%6s %7.0f Mo %s\n",$1,$2/1024,$3}'

sec "OOM et plantages (noyau, 30 derniers jours)"
journalctl -k --since "30 days ago" --no-pager 2>/dev/null \
	| grep -iE "out of memory|oom-kill|killed process|memory cgroup out of memory|hung_task|blocked for more than" \
	| tail -60
echo "(fin)"

sec "Sauvegardes"
cmd cat /etc/pve/jobs.cfg
cmd cat /etc/vzdump.conf

sec "Liste des CT"
cmd pct list

for id in $(pct list | awk 'NR>1{print $1}'); do
	sec "CT $id"
	pct config "$id" 2>&1 | grep -v '^description:' | grep -v '^#'
	cg="/sys/fs/cgroup/lxc/$id"
	if [[ -d "$cg" ]]; then
		for f in memory.max memory.current memory.peak memory.swap.max memory.swap.current cpu.max pids.current; do
			[[ -r "$cg/$f" ]] && printf '%-22s %s\n' "$f" "$(cat "$cg/$f")"
		done
		echo "--- memory.events (oom_kill = processus tués par manque de RAM depuis le démarrage)"
		cat "$cg/memory.events" 2>/dev/null
		echo "--- memory.stat (extrait)"
		grep -E '^(anon|file|kernel|sock|shmem) ' "$cg/memory.stat" 2>/dev/null
		echo "--- memory.pressure"
		cat "$cg/memory.pressure" 2>/dev/null
	fi
	if [[ "$(pct status "$id" 2>/dev/null)" == "status: running" ]]; then
		echo "--- dans le CT (lecture seule)"
		timeout 20 pct exec "$id" -- sh -c '
			free -m; df -h / | tail -1
			if command -v docker >/dev/null; then
				docker info --format "docker: driver={{.Driver}} images={{.Images}} conteneurs={{.Containers}}" 2>&1
				docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" 2>&1
				docker system df 2>&1
			fi
			ps -eo rss,comm --sort=-rss | head -8
			systemctl is-active actions.runner.* 2>/dev/null | head -3
		' 2>&1 || echo "(pct exec : code $?)"
	fi
done

sec "Fin"
echo "Rapport écrit dans $OUT"
