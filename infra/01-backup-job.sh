#!/usr/bin/env bash
# =============================================================================
# 01-backup-job.sh — Sauvegarde quotidienne des CT de production
# -----------------------------------------------------------------------------
# Crée (ou met à jour) un job vzdump planifié pour les CT 100, 401, 402, 403, 404.
#   • tous les jours à 03:30
#   • mode « snapshot » demandé ; sur le stockage « local » (type dir), Proxmox
#     bascule AUTOMATIQUEMENT en mode « suspend » (gel bref du CT, cohérent pour
#     Postgres) car un stockage dir ne sait pas faire de snapshot.
#   • compression zstd, rétention 7 jours (keep-daily=7)
#
# Ce script ne modifie AUCUN CT : il crée seulement une entrée dans
# /etc/pve/jobs.cfg (via l'API) et, si besoin et après confirmation, ajoute le
# type de contenu « backup » au stockage local.
#
# ⚠ Les sauvegardes sont sur le MÊME disque que les CT : elles protègent contre
#   une erreur (suppression, migration ratée), PAS contre une panne disque.
#   Prévoyez une copie externe (PBS, OVH Backup Storage…) — voir docs/INSTALL.md.
#
# Usage : bash infra/01-backup-job.sh
# Idempotent : relançable sans risque.
# =============================================================================
source "$(dirname "$0")/lib.sh"

JOB_ID="forge-prod-daily"
BACKUP_VMIDS=(100 401 402 403 404)
SCHEDULE="03:30"
STORAGE="$FORGE_STORAGE"

require_root
require_pve

title "Vérifications"
for id in "${BACKUP_VMIDS[@]}"; do
	if ct_exists "$id"; then
		ok "CT $id présent ($(pct config "$id" | awk -F': ' '/^hostname/{print $2}'))"
	else
		warn "CT $id introuvable — il sera ignoré par vzdump tant qu’il n’existe pas."
	fi
done

content="$(pvesh get "/storage/$STORAGE" --output-format json | perl -MJSON::PP -e 'local $/; print decode_json(<STDIN>)->{content} // ""')"
info "Types de contenu du stockage $STORAGE : $content"
need_content_change=0
[[ ",$content," == *",backup,"* ]] || need_content_change=1

info "Espace disque du stockage $STORAGE :"
pvesm status --storage "$STORAGE" | sed 's/^/    /'
total_used=0
for id in "${BACKUP_VMIDS[@]}"; do
	ct_exists "$id" || continue
	used=$(pvesh get "/nodes/$FORGE_NODE/lxc/$id/status/current" --output-format json | perl -MJSON::PP -e 'local $/; print int((decode_json(<STDIN>)->{disk} // 0))')
	total_used=$((total_used + used))
done
info "Données utilisées par ces CT : ~$((total_used / 1024 / 1024)) Mo (avant compression zstd, x7 jours au maximum)."

existing="$(pvesh get /cluster/backup --output-format json | perl -MJSON::PP -e 'local $/; my $j=decode_json(<STDIN>); for (@$j){ print "$_->{id}\n" }')"
job_exists=0
grep -qx "$JOB_ID" <<<"$existing" && job_exists=1

title "Ce que le script va faire"
if [[ $need_content_change -eq 1 ]]; then
	plan "Ajouter le type de contenu « backup » au stockage $STORAGE (actuellement : $content)"
fi
if [[ $job_exists -eq 1 ]]; then
	plan "Mettre à jour le job existant « $JOB_ID »"
else
	plan "Créer le job « $JOB_ID »"
fi
plan "CT : ${BACKUP_VMIDS[*]} — tous les jours à $SCHEDULE — mode snapshot (→ suspend sur dir) — zstd — 7 jours"
confirm "Appliquer ?"

if [[ $need_content_change -eq 1 ]]; then
	run pvesm set "$STORAGE" --content "${content:+$content,}backup"
	ok "Contenu « backup » ajouté au stockage $STORAGE."
fi

vmids_csv="$(IFS=,; echo "${BACKUP_VMIDS[*]}")"
common_args=(
	--schedule "$SCHEDULE"
	--storage "$STORAGE"
	--mode snapshot
	--compress zstd
	--vmid "$vmids_csv"
	--prune-backups keep-daily=7
	--enabled 1
	--notes-template '{{guestname}} — sauvegarde quotidienne'
	--comment "Sauvegarde quotidienne des CT de production (créé par Forge infra/01)"
)

if [[ $job_exists -eq 1 ]]; then
	run pvesh set "/cluster/backup/$JOB_ID" "${common_args[@]}"
else
	run pvesh create /cluster/backup --id "$JOB_ID" "${common_args[@]}"
fi
ok "Job de sauvegarde « $JOB_ID » en place."
pvesh get "/cluster/backup/$JOB_ID" | sed 's/^/    /'

title "Première sauvegarde"
if ask_yes_no "Lancer une première sauvegarde maintenant (peut prendre plusieurs minutes, gel bref de chaque CT) ?"; then
	run vzdump "${BACKUP_VMIDS[@]}" --storage "$STORAGE" --mode snapshot --compress zstd \
		--notes-template '{{guestname}} — sauvegarde initiale'
	ok "Sauvegarde initiale terminée."
	pvesm list "$STORAGE" --content backup | tail -n 10 | sed 's/^/    /'
else
	info "OK, la première sauvegarde aura lieu cette nuit à $SCHEDULE."
fi
