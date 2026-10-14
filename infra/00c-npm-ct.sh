#!/usr/bin/env bash
# =============================================================================
# 00c-npm-ct.sh — CT de Nginx Proxy Manager (10.10.10.2)
# -----------------------------------------------------------------------------
# NPM reçoit le trafic 80/443 de l'IP publique (DNAT posé par 00a) et le
# redirige vers les CT des projets ; Forge y crée les proxy hosts et les
# certificats Let's Encrypt de chaque projet.
#   • CT $NPM_CTID (100 par défaut), Ubuntu 24.04, unprivileged, nesting=1,keyctl=1,
#     1 cœur, 1 Go, 8 Go, IP 10.10.10.2/24 sur le bridge nat, démarrage automatique ;
#   • Docker CE + compose, NPM dans /opt/npm (données dans /opt/npm/data et
#     /opt/npm/letsencrypt), ports 80, 443 et 81 (administration) ;
#   • HORS du pool forge, et dans la liste des CT protégés : Forge ne peut ni le
#     modifier ni le supprimer. Il est sauvegardé par 01 (CT 100).
# L'administration (:81) n'est joignable que depuis le bridge (Forge, l'hôte,
# Tailscale) : seuls 80/443 sont redirigés depuis Internet.
#
# NPM déjà en place (http://10.10.10.2:81 répond) : rien n'est fait. Un CT qui
# existe déjà n'est JAMAIS modifié.
# Image : NPM_IMAGE (par défaut jc21/nginx-proxy-manager:latest ; fixez une version
# pour des réinstallations identiques, ex. NPM_IMAGE=jc21/nginx-proxy-manager:2.x.y).
# Usage : bash infra/00c-npm-ct.sh        Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

NPM_CTID="${NPM_CTID:-100}"
NPM_IP="${NPM_IP:-10.10.10.2}"
NPM_IMAGE="${NPM_IMAGE:-jc21/nginx-proxy-manager:latest}"
NPM_NAME="npm"

require_root
require_pve

npm_answers() { curl -fsS -o /dev/null -m 5 "http://$NPM_IP:81/" 2>/dev/null; }

title "Vérifications"
if npm_answers; then
	ok "NPM répond déjà sur http://$NPM_IP:81 : rien à faire."
	exit 0
fi
ip link show "$FORGE_BRIDGE" >/dev/null 2>&1 || die "Bridge $FORGE_BRIDGE absent : lancez d'abord infra/00a-network.sh."
[[ -f "/var/lib/vz/template/cache/$(basename "${FORGE_OSTEMPLATE#*:vztmpl/}")" ]] \
	|| die "Template OS introuvable : pveam update && pveam download local $(basename "${FORGE_OSTEMPLATE#*:vztmpl/}")"
mode="create"
if ct_exists "$NPM_CTID"; then
	name="$(pct config "$NPM_CTID" | awk -F': ' '/^hostname/{print $2}')"
	[[ "$name" == "$NPM_NAME" ]] || die "Le CT $NPM_CTID existe (« $name ») et NPM ne répond pas sur $NPM_IP:81. Ce script ne modifie pas un CT existant : vérifiez à la main, ou choisissez NPM_CTID=<libre>."
	pct config "$NPM_CTID" | grep -q "ip=$NPM_IP/" || die "Le CT $NPM_CTID n'a pas l'IP $NPM_IP. Abandon."
	mode="resume"
	warn "Le CT $NPM_CTID ($NPM_NAME) existe mais NPM ne répond pas : l'installation de Docker/NPM sera relancée (idempotente)."
else
	vmid_exists "$NPM_CTID" && die "L'ID $NPM_CTID est déjà utilisé par une VM."
	assert_ip_free "$NPM_IP"
fi

title "Ce que le script va faire"
[[ $mode == create ]] && plan "pct create $NPM_CTID ($NPM_NAME) : Ubuntu 24.04, 1 cœur, 1 Go, 8 Go, $NPM_IP/24 sur $FORGE_BRIDGE, onboot=1, hors pool"
plan "Installer Docker CE + compose, puis NPM ($NPM_IMAGE) dans /opt/npm : ports 80, 443, 81"
confirm "Continuer ?"

if [[ $mode == create ]]; then
	run pct create "$NPM_CTID" "$FORGE_OSTEMPLATE" \
		--hostname "$NPM_NAME" \
		--unprivileged 1 \
		--features nesting=1,keyctl=1 \
		--cores 1 --memory 1024 --swap 512 \
		--rootfs "$FORGE_STORAGE:8" \
		--net0 "name=eth0,bridge=$FORGE_BRIDGE,ip=$NPM_IP/24,gw=$FORGE_GATEWAY" \
		--ostype ubuntu \
		--onboot 1 \
		--tags npm \
		--description "Nginx Proxy Manager (80/443 depuis Internet, administration :81 via Tailscale). Créé par infra/00c-npm-ct.sh."
fi
if [[ "$(pct status "$NPM_CTID")" != "status: running" ]]; then
	run pct start "$NPM_CTID"
fi
wait_ct_network "$NPM_CTID"

title "Docker"
ct_run_script "$NPM_CTID" "$INFRA_DIR/provision/install-docker.sh"

title "Nginx Proxy Manager"
pct exec "$NPM_CTID" -- env NPM_IMAGE="$NPM_IMAGE" bash -s <<'EOF'
set -Eeuo pipefail
install -d -m 750 /opt/npm
cat >/opt/npm/docker-compose.yml <<YAML
# Nginx Proxy Manager — créé par infra/00c-npm-ct.sh (Forge).
services:
  npm:
    image: ${NPM_IMAGE}
    container_name: npm
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "81:81"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
YAML
cd /opt/npm && docker compose up -d
EOF
info "Attente de NPM sur http://$NPM_IP:81…"
for _ in $(seq 1 60); do
	npm_answers && break
	sleep 3
done
npm_answers || die "NPM ne répond pas sur http://$NPM_IP:81 après 3 min (pct exec $NPM_CTID -- docker logs npm)."
ok "NPM opérationnel."

title "Terminé"
info "Via Tailscale, ouvrez http://$NPM_IP:81 et créez le compte administrateur (premier lancement)."
info "Puis créez le compte « Forge » NON administrateur (docs/INSTALL.md §4) et saisissez-le dans Forge → Réglages → NPM."
