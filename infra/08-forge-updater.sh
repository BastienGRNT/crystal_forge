#!/usr/bin/env bash
# =============================================================================
# 08-forge-updater.sh — Mise à jour de Forge (CT 150) : service + déploiement
# -----------------------------------------------------------------------------
# Installe dans le CT 150 le service qui permet le bouton « Mettre à jour Forge »
# (Réglages → Mise à jour) :
#   • /usr/local/sbin/forge-update (infra/provision/forge-update.sh) ;
#   • forge-update.path + forge-update.service (systemd, HORS du conteneur Forge) :
#     dès que Forge dépose /opt/forge/updates/request.json, le service vérifie
#     l'archive, reconstruit l'image, redémarre le conteneur et revient à la
#     version précédente en cas d'échec ;
#   • /opt/forge/updates (propriétaire 1000 = utilisateur node du conteneur).
# Forge n'a ni le socket Docker ni accès à l'hôte : il ne fait que déposer
# l'archive de son dépôt (téléchargée avec le jeton GitHub) et lire le résultat.
#
# Mémoire : le build (vite) dépasse 1 Go. Le script propose de passer la limite
# du CT 150 à 2 Go (pct set 150 --memory 2048). Pour un CT, c'est une LIMITE, pas
# une réservation : Forge au repos n'en utilise qu'une petite partie.
#
# Option --from <dossier> : déploie aussi une copie locale du dépôt (sans git ni
# rsync), par le même service — utile pour la première installation du bouton.
# Premier déploiement (pas de /opt/forge/.env) : le .env est créé depuis
# .env.example avec une FORGE_MASTER_KEY neuve, écrite aussi dans
# /root/forge-master-key.txt (mode 600) : à ranger dans un gestionnaire de mots
# de passe, puis shred -u. Si ce fichier existe déjà, sa clé est réutilisée.
#
# Usage : bash infra/08-forge-updater.sh [--from /root/crystal_forge]
# Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

CT_ID=150
APP=/opt/forge
FROM=""
MASTER_KEY_FILE=/root/forge-master-key.txt

while [[ $# -gt 0 ]]; do
	case "$1" in
		--from) FROM="${2:-}"; shift 2 ;;
		*) die "Option inconnue : $1 (usage : $0 [--from /root/crystal_forge])" ;;
	esac
done

require_root
require_pve
assert_not_prod "$CT_ID"

title "Vérifications"
ct_exists "$CT_ID" || die "Le CT $CT_ID n’existe pas : lancez d’abord infra/04-forge-ct.sh."
[[ "$(pct config "$CT_ID" | awk -F': ' '/^hostname/{print $2}')" == forge ]] || die "Le CT $CT_ID ne s’appelle pas « forge ». Abandon."
[[ "$(pct status "$CT_ID")" == "status: running" ]] || die "Le CT $CT_ID est arrêté : pct start $CT_ID"
need_env=0
if ! pct exec "$CT_ID" -- test -f "$APP/.env"; then
	[[ -n "$FROM" ]] || die "$APP/.env absent dans le CT $CT_ID : relancez avec --from /root/crystal_forge pour le premier déploiement."
	need_env=1
fi
pct exec "$CT_ID" -- bash -c 'command -v jq && command -v curl && command -v docker' >/dev/null || die "jq, curl ou docker manquant dans le CT $CT_ID (infra/provision/install-docker.sh)."
ok "CT $CT_ID prêt (docker, jq, curl)."
[[ $need_env -eq 1 ]] && warn "Premier déploiement : $APP/.env sera créé (DRY_RUN=true, FORGE_MODE=live)."
if [[ -n "$FROM" ]]; then
	[[ -f "$FROM/Dockerfile" && -f "$FROM/docker-compose.yml" ]] || die "$FROM ne ressemble pas au dépôt crystal_forge (Dockerfile / docker-compose.yml absents)."
	ok "Source locale : $FROM"
fi

mem="$(pct config "$CT_ID" | awk -F': ' '/^memory/{print $2}')"
need_mem=0
[[ "${mem:-512}" -lt 2048 ]] && need_mem=1
info "Mémoire du CT $CT_ID : ${mem:-?} Mo"

title "Ce que le script va faire"
[[ $need_env -eq 1 ]] && plan "Créer $APP/.env depuis .env.example, FORGE_MASTER_KEY $([[ -f $MASTER_KEY_FILE ]] && echo "reprise de $MASTER_KEY_FILE" || echo "neuve, copiée dans $MASTER_KEY_FILE (600)")"
[[ $need_mem -eq 1 ]] && plan "pct set $CT_ID --memory 2048 (limite, nécessaire au build ; actuellement ${mem} Mo)"
plan "Installer /usr/local/sbin/forge-update, forge-update.path et forge-update.service dans le CT $CT_ID"
plan "Créer $APP/updates (propriétaire 1000:1000, mode 750)"
[[ -n "$FROM" ]] && plan "Déployer $FROM (sans node_modules, .svelte-kit, build, data, .git) via le service : build, redémarrage, retour arrière si échec"
confirm "Appliquer ?"

if [[ $need_mem -eq 1 ]]; then
	run pct set "$CT_ID" --memory 2048
	info "Retour arrière : pct set $CT_ID --memory $mem (le bouton « Mettre à jour » échouera alors faute de mémoire)."
fi

if [[ $need_env -eq 1 ]]; then
	title "Fichier .env"
	if [[ ! -f "$MASTER_KEY_FILE" ]]; then
		(umask 077 && openssl rand -base64 32 >"$MASTER_KEY_FILE")
	fi
	master_key="$(tr -d '\n' <"$MASTER_KEY_FILE")"
	[[ "$(printf '%s' "$master_key" | base64 -d 2>/dev/null | wc -c)" -eq 32 ]] || die "$MASTER_KEY_FILE ne contient pas une clé base64 de 32 octets."
	# La clé passe par l'entrée standard, jamais en argument (visible dans ps).
	FORGE_KEY="$master_key" awk '/^FORGE_MASTER_KEY=/ { print "FORGE_MASTER_KEY=" ENVIRON["FORGE_KEY"]; next } { print }' "$FROM/.env.example" \
		| pct exec "$CT_ID" -- bash -c "install -d -m 750 $APP && umask 077 && cat >$APP/.env"
	unset master_key
	ok "$APP/.env créé (mode 600)."
	warn "Rangez $MASTER_KEY_FILE dans votre gestionnaire de mots de passe, puis : shred -u $MASTER_KEY_FILE"
fi

title "Service de mise à jour"
run pct push "$CT_ID" "$INFRA_DIR/provision/forge-update.sh" /usr/local/sbin/forge-update --perms 755
pct exec "$CT_ID" -- bash -s <<EOF
set -Eeuo pipefail
install -d -o 1000 -g 1000 -m 750 $APP/updates
cat >/etc/systemd/system/forge-update.service <<'UNIT'
[Unit]
Description=Forge — mise à jour (build puis redémarrage du conteneur)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/forge-update
TimeoutStartSec=30min
UNIT
cat >/etc/systemd/system/forge-update.path <<'UNIT'
[Unit]
Description=Forge — surveille les demandes de mise à jour ($APP/updates/request.json)

[Path]
PathExists=$APP/updates/request.json
Unit=forge-update.service

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now forge-update.path
printf '{"version":1,"installedAt":"%s"}\n' "\$(date -Is)" >$APP/updates/updater.json
chmod 644 $APP/updates/updater.json
systemctl is-active forge-update.path
EOF
ok "Service forge-update installé (systemctl status forge-update.path dans le CT $CT_ID)."

if [[ -n "$FROM" ]]; then
	title "Déploiement de $FROM"
	stamp="local-$(date +%Y%m%d-%H%M%S)"
	archive="$(mktemp --suffix=.tar.gz)"
	trap 'rm -f "$archive"' EXIT
	# Un dossier racine unique, comme les archives GitHub (le service le retire).
	run tar -C "$(dirname "$FROM")" --exclude=node_modules --exclude=.svelte-kit --exclude=build --exclude=data \
		--exclude=.git --exclude=updates --exclude=.env -czf "$archive" "$(basename "$FROM")"
	run pct push "$CT_ID" "$archive" "$APP/updates/forge-$stamp.tar.gz" --user 1000 --group 1000
	pct exec "$CT_ID" -- bash -c "printf '{\"sha\":\"%s\",\"file\":\"forge-%s.tar.gz\",\"message\":\"Copie locale\",\"requestedAt\":%s}' '$stamp' '$stamp' \"\$(date +%s000)\" >$APP/updates/request.json.part && mv $APP/updates/request.json.part $APP/updates/request.json"
	info "Mise à jour lancée par le service ; suivi du journal (Ctrl+C n’interrompt pas la mise à jour) :"
	for _ in $(seq 1 900); do
		state="$(pct exec "$CT_ID" -- bash -c "jq -r 'select(.sha == \"$stamp\") | .state' $APP/updates/status.json 2>/dev/null" || true)"
		[[ "$state" == done || "$state" == failed ]] && break
		sleep 2
	done
	pct exec "$CT_ID" -- cat "$APP/updates/update.log" | sed 's/^/    /'
	[[ "$state" == done ]] || die "La mise à jour n’a pas abouti (état : ${state:-inconnu}). La version précédente a été remise en place."
	ok "Forge déployé depuis $FROM."
fi

title "Terminé"
info "Dans Forge : Réglages → Mise à jour → Vérifier, puis « Mettre à jour Forge »."
info "Le jeton GitHub doit pouvoir lire le dépôt de Forge (Contents : Read) — réglage forge.updateRepo."
