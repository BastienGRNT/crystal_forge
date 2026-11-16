#!/usr/bin/env bash
# =============================================================================
# 09-host-setup.sh — Réglages de l'hôte qui exigent root (lancé par bootstrap.sh)
# -----------------------------------------------------------------------------
# Tout le reste (jobs de sauvegarde, RAM de NPM, priorités CPU, caches de build)
# est fait PAR FORGE, avec son jeton API, toutes les 6 h. Ce script ne prépare que
# ce que l'API ne permet pas à un jeton non-root :
#
#   1. Plafond du cache ZFS (ARC) à 10 % de la RAM (1 Go min.), comme l'installeur
#      Proxmox 8.1+. Sans plafond, l'ARC monte à 50 % de la RAM et l'hôte swappe
#      quand un build démarre. À chaud + /etc/modprobe.d/zfs.conf.
#   2. vm.swappiness=10 (/etc/sysctl.d/90-forge.conf) : la RAM reste aux CT.
#   3. Stockage « forge-backups » (dossier /var/lib/vz/forge-backups, contenu
#      backup) : Forge y a les droits de gérer ses sauvegardes, et SEULEMENT là.
#   4. /etc/vzdump.conf : dossier temporaire des sauvegardes sur ce stockage (pas
#      /var/tmp, sur /). Réservé à root dans l'API, d'où ce réglage global.
#   5. Jobs « forge-* » déjà créés par l'ancien script 01 : basculés sur
#      forge-backups, sans leur tmpdir (sinon Forge ne pourrait plus les modifier).
#      Les anciennes sauvegardes restent sur « local » (rien n'est supprimé).
#
# Ne touche à AUCUN CT. Idempotent : ne fait que ce qui manque.
# Usage : bash infra/09-host-setup.sh   (ou bash infra/bootstrap.sh)
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve

BK_STORAGE="forge-backups"
BK_PATH="/var/lib/vz/forge-backups"
BK_TMP="$BK_PATH/tmp"
SWAPPINESS=10

total_bytes=$(awk '/^MemTotal:/{print $2 * 1024}' /proc/meminfo)
arc_target=$(( total_bytes / 10 ))
(( arc_target < 1073741824 )) && arc_target=1073741824

todo_arc=0 todo_swap=0 todo_storage=0 todo_tmpdir=0
if [[ -r /sys/module/zfs/parameters/zfs_arc_max ]] && ! grep -qs "zfs_arc_max=$arc_target\b" /etc/modprobe.d/zfs.conf; then todo_arc=1; fi
grep -qs "^vm.swappiness = $SWAPPINESS$" /etc/sysctl.d/90-forge.conf || todo_swap=1
pvesm status --storage "$BK_STORAGE" >/dev/null 2>&1 || todo_storage=1
grep -qsx "tmpdir: $BK_TMP" /etc/vzdump.conf || todo_tmpdir=1
# Jobs forge-* à migrer : « id<TAB>a_un_tmpdir », pour ceux qui ne sont pas sur forge-backups ou ont un tmpdir.
mapfile -t jobs_to_migrate < <(pvesh get /cluster/backup --output-format json | perl -MJSON::PP -e '
	local $/; for (@{decode_json(<STDIN>)}) {
		next unless ($_->{id} // "") =~ /^forge-/;
		print "$_->{id}\t" . (defined $_->{tmpdir} ? 1 : 0) . "\n" if ($_->{storage} // "") ne $ARGV[0] || defined $_->{tmpdir};
	}' "$BK_STORAGE")

title "Réglages de l'hôte"
if (( todo_arc + todo_swap + todo_storage + todo_tmpdir + ${#jobs_to_migrate[@]} == 0 )); then
	ok "Tout est déjà en place : rien à faire."
	exit 0
fi
(( todo_arc )) && plan "Plafond du cache ZFS : $(( arc_target / 1048576 )) Mo (à chaud + /etc/modprobe.d/zfs.conf)"
(( todo_swap )) && plan "vm.swappiness = $SWAPPINESS (à chaud + /etc/sysctl.d/90-forge.conf)"
(( todo_storage )) && plan "Créer le stockage « $BK_STORAGE » ($BK_PATH, contenu : sauvegardes)"
(( todo_tmpdir )) && plan "/etc/vzdump.conf : tmpdir: $BK_TMP"
for j in "${jobs_to_migrate[@]}"; do plan "Job « ${j%%$'\t'*} » → stockage $BK_STORAGE$([[ ${j##*$'\t'} == 1 ]] && echo ', sans tmpdir')"; done
confirm "Appliquer ?"

if (( todo_arc )); then
	conf=/etc/modprobe.d/zfs.conf
	touch "$conf"
	if grep -q 'zfs_arc_max=' "$conf"; then
		run sed -i -E "s/zfs_arc_max=[0-9]+/zfs_arc_max=$arc_target/" "$conf"
	else
		run sh -c "echo 'options zfs zfs_arc_max=$arc_target' >> '$conf'"
	fi
	# Refusé par le noyau si inférieur à zfs_arc_min : signalé sans s'arrêter.
	if echo "$arc_target" > /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null; then
		ok "Plafond du cache ZFS appliqué à chaud (il redescend progressivement)."
	else
		warn "Plafond refusé à chaud (zfs_arc_min plus élevé ?) : il s'appliquera au prochain redémarrage."
	fi
	[[ "$(findmnt -no FSTYPE /)" == zfs ]] && run update-initramfs -u -k all
fi

if (( todo_swap )); then
	run sh -c "echo 'vm.swappiness = $SWAPPINESS' > /etc/sysctl.d/90-forge.conf"
	run sysctl -q -p /etc/sysctl.d/90-forge.conf
	ok "vm.swappiness = $(sysctl -n vm.swappiness)"
fi

if (( todo_storage )); then
	run mkdir -p "$BK_PATH"
	run pvesm add dir "$BK_STORAGE" --path "$BK_PATH" --content backup
	ok "Stockage « $BK_STORAGE » créé."
fi

if (( todo_tmpdir )); then
	run mkdir -p "$BK_TMP"
	touch /etc/vzdump.conf
	if grep -qE '^tmpdir:' /etc/vzdump.conf; then
		run sed -i -E "s|^tmpdir:.*|tmpdir: $BK_TMP|" /etc/vzdump.conf
	else
		run sh -c "echo 'tmpdir: $BK_TMP' >> /etc/vzdump.conf"
	fi
	ok "Dossier temporaire des sauvegardes : $BK_TMP"
fi

for j in "${jobs_to_migrate[@]}"; do
	id="${j%%$'\t'*}"
	if [[ ${j##*$'\t'} == 1 ]]; then
		run pvesh set "/cluster/backup/$id" --storage "$BK_STORAGE" --delete tmpdir
	else
		run pvesh set "/cluster/backup/$id" --storage "$BK_STORAGE"
	fi
	ok "Job « $id » sur $BK_STORAGE."
done
(( ${#jobs_to_migrate[@]} )) && info "Les anciennes sauvegardes restent sur « local » (rien supprimé) ; supprimables dans Proxmox → local → Sauvegardes une fois les nouvelles en place."
exit 0
