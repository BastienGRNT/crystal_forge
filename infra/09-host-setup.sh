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
#   6. Stockage « forge-ct » (zfspool, dataset <pool>/forge-ct, contenu rootdir,
#      sparse) sur le pool ZFS qui porte /var/lib/vz. Les nouveaux CT y sont créés
#      par Forge ; les anciens y passent depuis Forge (onglet Conteneur). Ignoré si
#      /var/lib/vz n'est pas sur ZFS.
#   7. zram (paquet zram-tools, zstd, 25 % de la RAM, priorité 100) : un swap
#      compressé en RAM qui amortit les pointes au lieu de remplir le swap disque.
#   8. Protection mémoire de NPM (CT 100, 256 Mo) et de Forge (CT 150, 512 Mo) :
#      clé lxc.cgroup2.memory.low (réservée à root) + valeur posée à chaud. Sous
#      pression, le noyau reprend d'abord la mémoire des autres CT.
#
# Ne redémarre AUCUN CT. Idempotent : ne fait que ce qui manque.
# Usage : bash infra/09-host-setup.sh   (ou bash infra/bootstrap.sh)
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve

BK_STORAGE="forge-backups"
BK_PATH="/var/lib/vz/forge-backups"
BK_TMP="$BK_PATH/tmp"
SWAPPINESS=10
ZFS_STORAGE="forge-ct"
# Pool ZFS qui porte /var/lib/vz (ex. « data/vz » → « data »), vide si ce n'est pas du ZFS.
vz_src="$(findmnt -no FSTYPE,SOURCE --target /var/lib/vz 2>/dev/null || true)"
ZFS_POOL=""
[[ "$vz_src" == zfs\ * ]] && ZFS_POOL="$(awk '{print $2}' <<<"$vz_src" | cut -d/ -f1)"
ZFS_DATASET="${ZFS_POOL:+$ZFS_POOL/$ZFS_STORAGE}"

total_bytes=$(awk '/^MemTotal:/{print $2 * 1024}' /proc/meminfo)
arc_target=$(( total_bytes / 10 ))
(( arc_target < 1073741824 )) && arc_target=1073741824

todo_arc=0 todo_swap=0 todo_storage=0 todo_tmpdir=0 todo_zfs=0 todo_zram=0
# CT critiques protégés : « vmid:octets ».
MEM_LOW=("100:268435456" "150:536870912")
swapon --show=NAME --noheadings 2>/dev/null | grep -q zram || todo_zram=1
mem_low_todo=()
for e in "${MEM_LOW[@]}"; do
	id="${e%%:*}"
	[[ -f "/etc/pve/lxc/$id.conf" ]] || continue
	grep -qx "lxc.cgroup2.memory.low: ${e##*:}" "/etc/pve/lxc/$id.conf" || mem_low_todo+=("$e")
done
if [[ -r /sys/module/zfs/parameters/zfs_arc_max ]] && ! grep -qs "zfs_arc_max=$arc_target\b" /etc/modprobe.d/zfs.conf; then todo_arc=1; fi
grep -qs "^vm.swappiness = $SWAPPINESS$" /etc/sysctl.d/90-forge.conf || todo_swap=1
pvesm status --storage "$BK_STORAGE" >/dev/null 2>&1 || todo_storage=1
grep -qsx "tmpdir: $BK_TMP" /etc/vzdump.conf || todo_tmpdir=1
if [[ -n "$ZFS_POOL" ]] && ! pvesm status --storage "$ZFS_STORAGE" >/dev/null 2>&1; then todo_zfs=1; fi
# Jobs forge-* à migrer : « id<TAB>a_un_tmpdir », pour ceux qui ne sont pas sur forge-backups ou ont un tmpdir.
mapfile -t jobs_to_migrate < <(pvesh get /cluster/backup --output-format json | perl -MJSON::PP -e '
	local $/; for (@{decode_json(<STDIN>)}) {
		next unless ($_->{id} // "") =~ /^forge-/;
		print "$_->{id}\t" . (defined $_->{tmpdir} ? 1 : 0) . "\n" if ($_->{storage} // "") ne $ARGV[0] || defined $_->{tmpdir};
	}' "$BK_STORAGE")

title "Réglages de l'hôte"
if (( todo_arc + todo_swap + todo_storage + todo_tmpdir + todo_zfs + todo_zram + ${#mem_low_todo[@]} + ${#jobs_to_migrate[@]} == 0 )); then
	ok "Tout est déjà en place : rien à faire."
	exit 0
fi
(( todo_arc )) && plan "Plafond du cache ZFS : $(( arc_target / 1048576 )) Mo (à chaud + /etc/modprobe.d/zfs.conf)"
(( todo_swap )) && plan "vm.swappiness = $SWAPPINESS (à chaud + /etc/sysctl.d/90-forge.conf)"
(( todo_storage )) && plan "Créer le stockage « $BK_STORAGE » ($BK_PATH, contenu : sauvegardes)"
(( todo_zfs )) && plan "Créer le stockage ZFS « $ZFS_STORAGE » (dataset $ZFS_DATASET, disques des CT)"
(( todo_zram )) && plan "zram : swap compressé en RAM (zram-tools, zstd, 25 % de la RAM, prioritaire sur le swap disque)"
for e in "${mem_low_todo[@]}"; do plan "CT ${e%%:*} : mémoire protégée $(( ${e##*:} / 1048576 )) Mo (lxc.cgroup2.memory.low, à chaud, sans redémarrage)"; done
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

if (( todo_zfs )); then
	zfs list -H -o name "$ZFS_DATASET" >/dev/null 2>&1 || run zfs create "$ZFS_DATASET"
	run pvesm add zfspool "$ZFS_STORAGE" --pool "$ZFS_DATASET" --content rootdir --sparse 1
	ok "Stockage ZFS « $ZFS_STORAGE » créé : Forge y mettra les nouveaux CT."
fi

if (( todo_zram )); then
	run apt-get install -y zram-tools
	run sh -c "printf 'ALGO=zstd\nPERCENT=25\nPRIORITY=100\n' > /etc/default/zramswap"
	run systemctl enable zramswap.service
	run systemctl restart zramswap.service
	ok "zram actif : $(swapon --show=NAME,SIZE --noheadings | grep zram | tr -s ' ')"
fi

for e in "${mem_low_todo[@]}"; do
	id="${e%%:*}" val="${e##*:}" conf="/etc/pve/lxc/${e%%:*}.conf"
	# La clé doit être dans la section principale, avant les instantanés « [nom] ».
	run perl -0pi -e "s/^lxc\.cgroup2\.memory\.low:.*\n//mg; s/^(?=\[)|\z/lxc.cgroup2.memory.low: $val\n/m" "$conf"
	if [[ -w "/sys/fs/cgroup/lxc/$id/memory.low" ]]; then
		echo "$val" > "/sys/fs/cgroup/lxc/$id/memory.low" && ok "CT $id : $(( val / 1048576 )) Mo protégés (à chaud et au prochain démarrage)."
	else
		ok "CT $id : $(( val / 1048576 )) Mo protégés au prochain démarrage du CT."
	fi
done

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
