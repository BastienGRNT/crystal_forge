#!/usr/bin/env bash
# =============================================================================
# 00a-network.sh — Réseau interne des CT : bridge « nat », NAT sortant, 80/443 → NPM
# -----------------------------------------------------------------------------
# Met en place (ou vérifie) ce dont dépendent tous les CT :
#   • bridge « nat » 10.10.10.1/24, sans port physique (réseau privé des CT) ;
#   • routage IPv4 (net.ipv4.ip_forward=1, persistant dans /etc/sysctl.d) ;
#   • MASQUERADE de 10.10.10.0/24 vers l'interface publique (Internet pour les CT) ;
#   • DNAT des ports 80/443 de l'interface publique vers NPM (10.10.10.2) ;
#   • zone conntrack des ponts fwbr (NAT des CT avec pare-feu, voir 07).
#
# Serveur neuf : le bloc « iface nat » est ajouté à /etc/network/interfaces (copie
# de sauvegarde, validation ifquery), puis SEULE l'interface nat est montée
# (ifup nat) : vmbr0 et le reste du réseau ne sont pas touchés.
# Bridge déjà présent : seules les règles manquantes sont ajoutées (tout de suite
# et dans le bloc existant). Ce qui existe déjà n'est jamais modifié.
# Le script ne lance JAMAIS ifreload.
#
# Retour arrière : cp <copie affichée> /etc/network/interfaces, puis ifdown nat
#   (serveur neuf uniquement : sur un serveur en production, la prod dépend de nat).
# Usage : bash infra/00a-network.sh        Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

NPM_IP="${NPM_IP:-10.10.10.2}"
SUBNET="10.10.10.0/24"
SYSCTL_FILE="/etc/sysctl.d/99-forge-ip-forward.conf"

require_root
require_pve
command -v ifquery >/dev/null || die "ifquery introuvable (ifupdown2 attendu sur Proxmox)."

title "État actuel"
PUBLIC_IF="$(ip -4 route show default | awk '{print $5; exit}')"
[[ -n "$PUBLIC_IF" ]] || die "Aucune route par défaut : interface publique introuvable."
PUBLIC_IP="$(ip -4 -o addr show dev "$PUBLIC_IF" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
info "Interface publique : $PUBLIC_IF ($PUBLIC_IP)"

# Règles (texte iptables, sans -A/-I) et lignes du bloc correspondantes.
MASQ=(-s "$SUBNET" -o "$PUBLIC_IF" -j MASQUERADE)
DNAT=(-i "$PUBLIC_IF" -p tcp -m multiport --dports 80,443 -j DNAT --to-destination "$NPM_IP")
ZONE=(-i 'fwbr+' -j CT --zone 1)
L_MASQ_UP="	post-up   iptables -t nat -A POSTROUTING -s '$SUBNET' -o $PUBLIC_IF -j MASQUERADE"
L_MASQ_DOWN="	post-down iptables -t nat -D POSTROUTING -s '$SUBNET' -o $PUBLIC_IF -j MASQUERADE"
L_DNAT_UP="	post-up   iptables -t nat -A PREROUTING -i $PUBLIC_IF -p tcp -m multiport --dports 80,443 -j DNAT --to-destination $NPM_IP"
L_DNAT_DOWN="	post-down iptables -t nat -D PREROUTING -i $PUBLIC_IF -p tcp -m multiport --dports 80,443 -j DNAT --to-destination $NPM_IP"
L_ZONE_UP="	post-up   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1"
L_ZONE_DOWN="	post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1"

# Un DNAT existant vers NPM pour ce port, quelle que soit sa forme (--dport, --dports, -d …).
dnat_live_has() {
	iptables -t nat -S PREROUTING | grep -E -- "-j DNAT --to-destination ${NPM_IP//./\\.}(:[0-9]+)?( |$)" \
		| grep -qE -- "--dports? ([0-9,:]*,)?$1(,|:| |$)"
}
dnat_file_has() {
	grep -E -- "DNAT --to-destination ${NPM_IP//./\\.}(:[0-9]+)?( |$)" "$IFACES_FILE" | grep -qE -- "--dports? ([0-9,:]*,)?$1(,|:| |$)"
}

bridge_file=0
grep -qE "^iface[[:space:]]+$FORGE_BRIDGE([[:space:]]|$)" "$IFACES_FILE" && bridge_file=1
bridge_live=0
ip link show "$FORGE_BRIDGE" >/dev/null 2>&1 && bridge_live=1
if [[ $bridge_file -eq 0 && $bridge_live -eq 1 ]]; then
	die "Le bridge $FORGE_BRIDGE existe mais pas dans $IFACES_FILE (défini ailleurs ?) : configuration manuelle requise."
fi
if [[ $bridge_file -eq 1 ]] && ! ip -4 addr show dev "$FORGE_BRIDGE" 2>/dev/null | grep -q "inet $FORGE_GATEWAY/"; then
	warn "Le bridge $FORGE_BRIDGE n'a pas l'adresse $FORGE_GATEWAY : vérifiez $IFACES_FILE (rien n'est modifié sur ce point)."
fi

forward_live=0; [[ "$(sysctl -n net.ipv4.ip_forward)" == 1 ]] && forward_live=1
forward_file=0; grep -rqsE '^[[:space:]]*net\.ipv4\.ip_forward[[:space:]]*=[[:space:]]*1' /etc/sysctl.conf /etc/sysctl.d/ && forward_file=1
masq_live=0; iptables -t nat -S POSTROUTING | grep -qE -- "-s ${SUBNET//./\\.} .*-j MASQUERADE" && masq_live=1
masq_file=0; grep -qE -- "${SUBNET//./\\.}.*MASQUERADE" "$IFACES_FILE" && masq_file=1
dnat_live=0; dnat_live_has 80 && dnat_live_has 443 && dnat_live=1
dnat_file=0; dnat_file_has 80 && dnat_file_has 443 && dnat_file=1
zone_live=0; iptables -t raw -C PREROUTING "${ZONE[@]}" 2>/dev/null && zone_live=1
zone_file=0; grep -qF -- "-i fwbr+ -j CT --zone 1" "$IFACES_FILE" && zone_file=1

yn() { [[ "$1" -eq 1 ]] && echo oui || echo non; }
info "Bridge $FORGE_BRIDGE : fichier $(yn $bridge_file), actif $(yn $bridge_live)"
info "ip_forward : actif $(yn $forward_live), persistant $(yn $forward_file)"
info "MASQUERADE $SUBNET : actif $(yn $masq_live), fichier $(yn $masq_file)"
info "DNAT 80/443 → $NPM_IP : actif $(yn $dnat_live), fichier $(yn $dnat_file)"
info "Zone conntrack fwbr+ : active $(yn $zone_live), fichier $(yn $zone_file)"

if [[ $bridge_file -eq 1 && $bridge_live -eq 1 && $forward_live -eq 1 && $forward_file -eq 1 && $masq_live -eq 1 && $masq_file -eq 1 \
	&& $dnat_live -eq 1 && $dnat_file -eq 1 && $zone_live -eq 1 && $zone_file -eq 1 ]]; then
	ok "Réseau interne déjà en place : rien à faire."
	exit 0
fi

BACKUP="$IFACES_FILE.forge-bak-$(date +%Y%m%d-%H%M%S)"
title "Ce que le script va faire"
[[ $forward_live -eq 0 || $forward_file -eq 0 ]] && plan "net.ipv4.ip_forward=1 (immédiat + $SYSCTL_FILE)"
if [[ $bridge_file -eq 0 ]]; then
	plan "Copie de sauvegarde : $BACKUP"
	plan "Ajouter le bloc « iface $FORGE_BRIDGE » ($FORGE_GATEWAY/24, sans port physique) avec MASQUERADE, DNAT 80/443 → $NPM_IP et zone conntrack"
	plan "Valider avec ifquery, puis monter UNIQUEMENT cette interface : ifup $FORGE_BRIDGE (pas d'ifreload)"
else
	missing=()
	[[ $masq_file -eq 0 ]] && missing+=("$L_MASQ_UP" "$L_MASQ_DOWN")
	[[ $dnat_file -eq 0 ]] && missing+=("$L_DNAT_UP" "$L_DNAT_DOWN")
	[[ $zone_file -eq 0 ]] && missing+=("$L_ZONE_UP" "$L_ZONE_DOWN")
	[[ $masq_live -eq 0 ]] && plan "iptables -t nat -A POSTROUTING ${MASQ[*]}   (immédiat)"
	[[ $dnat_live -eq 0 ]] && plan "iptables -t nat -A PREROUTING ${DNAT[*]}   (immédiat)"
	[[ $zone_live -eq 0 ]] && plan "iptables -t raw -I PREROUTING ${ZONE[*]}   (immédiat)"
	if [[ ${#missing[@]} -gt 0 ]]; then
		plan "Copie de sauvegarde : $BACKUP, puis ajout au bloc « iface $FORGE_BRIDGE » :"
		for l in "${missing[@]}"; do plan "  ${l#	}"; done
	fi
fi
[[ $dnat_live -eq 0 ]] && warn "Les ports 80/443 de $PUBLIC_IP seront redirigés vers NPM ($NPM_IP) : rien ne doit écouter dessus sur l'hôte."
confirm "Appliquer ?"

if [[ $forward_live -eq 0 || $forward_file -eq 0 ]]; then
	printf '# Routage IPv4 pour le NAT des CT (Forge, infra/00a-network.sh)\nnet.ipv4.ip_forward = 1\n' >"$SYSCTL_FILE"
	run sysctl -q -p "$SYSCTL_FILE"
fi

if [[ $bridge_file -eq 0 ]]; then
	ifaces_append_block "$FORGE_BRIDGE" "$BACKUP" \
		"auto $FORGE_BRIDGE" \
		"iface $FORGE_BRIDGE inet static" \
		"	address $FORGE_GATEWAY/24" \
		"	bridge-ports none" \
		"	bridge-stp off" \
		"	bridge-fd 0" \
		"$L_MASQ_UP" "$L_MASQ_DOWN" "$L_DNAT_UP" "$L_DNAT_DOWN" "$L_ZONE_UP" "$L_ZONE_DOWN"
	if ! run ifup "$FORGE_BRIDGE"; then
		ifdown "$FORGE_BRIDGE" >/dev/null 2>&1 || true
		ifaces_restore_die "$BACKUP" "ifup $FORGE_BRIDGE a échoué"
	fi
	ok "Bridge $FORGE_BRIDGE actif."
else
	[[ $masq_live -eq 0 ]] && run iptables -t nat -A POSTROUTING "${MASQ[@]}"
	[[ $dnat_live -eq 0 ]] && run iptables -t nat -A PREROUTING "${DNAT[@]}"
	[[ $zone_live -eq 0 ]] && run iptables -t raw -I PREROUTING "${ZONE[@]}"
	[[ ${#missing[@]} -gt 0 ]] && ifaces_add_to_block "$FORGE_BRIDGE" "$BACKUP" "${missing[@]}"
fi

title "Terminé"
ip -4 addr show dev "$FORGE_BRIDGE" | sed 's/^/    /'
iptables -t nat -S | grep -E 'MASQUERADE|DNAT' | sed 's/^/    /' || true
[[ -f "$BACKUP" ]] && info "Retour arrière du fichier : cp $BACKUP $IFACES_FILE"
