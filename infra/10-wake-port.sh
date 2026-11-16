#!/usr/bin/env bash
# =============================================================================
# 10-wake-port.sh — Port 3001 de Forge (page de réveil des serveurs de dev endormis)
# -----------------------------------------------------------------------------
# Ajoute au pare-feu du CT 150 une règle : le port 3001 n'accepte que NPM
# (10.10.10.2) et la machine elle-même. Rien d'autre ne change. Relançable.
# =============================================================================
source "$(dirname "$0")/lib.sh"
require_root
require_pve

CT_ID=150
NPM_IP="${NPM_IP:-10.10.10.2}"
FW=/usr/local/sbin/forge-firewall

if pct exec "$CT_ID" -- grep -q FORGE-WAKE "$FW" 2>/dev/null; then
	ok "Port de réveil déjà filtré : rien à faire."
	exit 0
fi
plan "CT $CT_ID : ajouter à $FW la chaîne FORGE-WAKE (port 3001 accepté depuis $NPM_IP et 127.0.0.1 seulement), puis relancer le pare-feu"
confirm || exit 0
pct exec "$CT_ID" -- bash -s <<SCRIPT
set -Eeuo pipefail
cat >>"$FW" <<'RULES'
# Page de réveil des serveurs de dev endormis : NPM seulement.
iptables -N FORGE-WAKE 2>/dev/null || iptables -F FORGE-WAKE
iptables -A FORGE-WAKE -s $NPM_IP/32 -j ACCEPT
iptables -A FORGE-WAKE -s 127.0.0.0/8 -j ACCEPT
iptables -A FORGE-WAKE -j DROP
iptables -C INPUT -p tcp --dport 3001 -j FORGE-WAKE 2>/dev/null || iptables -I INPUT -p tcp --dport 3001 -j FORGE-WAKE
RULES
systemctl restart forge-firewall.service
iptables -S FORGE-WAKE
SCRIPT
ok "Port de réveil filtré."
