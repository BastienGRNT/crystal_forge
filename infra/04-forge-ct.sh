#!/usr/bin/env bash
# =============================================================================
# 04-forge-ct.sh — CT 150 « forge » qui héberge l'application Forge
# -----------------------------------------------------------------------------
#   • CT 150, Ubuntu 24.04, unprivileged, nesting=1,keyctl=1, 1 cœur, 1 Go, 512 Mo swap, 8 Go
#   • IP 10.10.10.15/24 sur le bridge nat, démarrage automatique
#   • HORS du pool forge : Forge ne peut ni s'arrêter ni se supprimer lui-même
#   • Docker CE + compose
#   • pare-feu : le port 3000 n'est joignable que depuis 10.10.10.1 (l'hôte, par
#     où arrive Tailscale avec SNAT) et 100.64.0.0/10 (Tailscale sans SNAT).
#     Les autres CT du bridge (dont les apps de prod) ne peuvent pas joindre Forge.
#   • aucun proxy host NPM : Forge n'est pas exposé sur Internet.
#
# Usage : bash infra/04-forge-ct.sh
# Idempotent : si le CT 150 existe déjà (hostname forge), seuls Docker et le
# pare-feu sont (ré)appliqués.
# =============================================================================
source "$(dirname "$0")/lib.sh"

CT_ID=150
CT_NAME="forge"
CT_IP="10.10.10.15"
FORGE_PORT=3000

require_root
require_pve
assert_not_prod "$CT_ID"

title "Vérifications"
mode="create"
if ct_exists "$CT_ID"; then
	name="$(pct config "$CT_ID" | awk -F': ' '/^hostname/{print $2}')"
	[[ "$name" == "$CT_NAME" ]] || die "Le CT $CT_ID existe et s’appelle « $name ». Abandon."
	mode="resume"
	warn "Le CT $CT_ID existe déjà : Docker et le pare-feu seront (ré)appliqués."
else
	vmid_exists "$CT_ID" && die "L’ID $CT_ID est déjà utilisé."
	assert_ip_free "$CT_IP"
fi

title "Ce que le script va faire"
if [[ $mode == create ]]; then
	plan "pct create $CT_ID ($CT_NAME) : Ubuntu 24.04, 1 cœur, 1 Go RAM, 512 Mo swap, 8 Go, $CT_IP/24 sur $FORGE_BRIDGE, onboot=1, hors pool"
fi
plan "Installer Docker CE + compose"
plan "Pare-feu : port $FORGE_PORT accepté depuis 10.10.10.1 et 100.64.0.0/10 uniquement"
plan "Créer /opt/forge (où déployer l’application)"
confirm "Continuer ?"

if [[ $mode == create ]]; then
	run pct create "$CT_ID" "$FORGE_OSTEMPLATE" \
		--hostname "$CT_NAME" \
		--unprivileged 1 \
		--features nesting=1,keyctl=1 \
		--cores 1 --memory 1024 --swap 512 \
		--rootfs "$FORGE_STORAGE:8" \
		--net0 "name=eth0,bridge=$FORGE_BRIDGE,ip=$CT_IP/24,gw=$FORGE_GATEWAY" \
		--ostype ubuntu \
		--onboot 1 \
		--tags forge-app \
		--description "Forge — mini-PaaS. Accessible uniquement via Tailscale : http://$CT_IP:$FORGE_PORT"
fi
if [[ "$(pct status "$CT_ID")" != "status: running" ]]; then
	run pct start "$CT_ID"
fi
wait_ct_network "$CT_ID"

title "Docker"
ct_run_script "$CT_ID" "$INFRA_DIR/provision/install-docker.sh"

title "Pare-feu"
pct exec "$CT_ID" -- bash -s <<EOF
set -Eeuo pipefail
cat >/usr/local/sbin/forge-firewall <<'SCRIPT'
#!/usr/bin/env bash
# Forge (network_mode: host) : n'accepte le port $FORGE_PORT que depuis l'hôte/Tailscale.
set -e
iptables -N FORGE-IN 2>/dev/null || iptables -F FORGE-IN
iptables -A FORGE-IN -s 10.10.10.1/32 -j ACCEPT
iptables -A FORGE-IN -s 100.64.0.0/10 -j ACCEPT
iptables -A FORGE-IN -s 127.0.0.0/8 -j ACCEPT
iptables -A FORGE-IN -j DROP
iptables -C INPUT -p tcp --dport $FORGE_PORT -j FORGE-IN 2>/dev/null || iptables -I INPUT -p tcp --dport $FORGE_PORT -j FORGE-IN
SCRIPT
chmod 755 /usr/local/sbin/forge-firewall
cat >/etc/systemd/system/forge-firewall.service <<'UNIT'
[Unit]
Description=Forge — filtre le port de l'interface web
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/forge-firewall

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now forge-firewall.service
systemctl restart forge-firewall.service
iptables -S FORGE-IN
install -d -m 750 /opt/forge
EOF
ok "Pare-feu actif."

title "Terminé"
info "CT $CT_ID prêt. Étape suivante : déployer Forge dans /opt/forge (docs/INSTALL.md, section « Déployer Forge »)."
info "Interface (après déploiement) : http://$CT_IP:$FORGE_PORT — via Tailscale uniquement."
