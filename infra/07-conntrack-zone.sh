#!/usr/bin/env bash
# =============================================================================
# 07-conntrack-zone.sh — NAT des CT dont le pare-feu Proxmox est actif (firewall=1)
# -----------------------------------------------------------------------------
# Avec firewall=1 sur net0 (ce que pose Forge sur chaque CT de projet), le trafic
# du CT traverse le pont fwbr<id>i0 et la connexion est suivie (conntrack) sur ce
# pont : la règle « MASQUERADE -o vmbr0 » du bridge nat ne s'applique plus. Les
# paquets sortent avec la source 10.10.10.x et le CT n'a pas Internet (config.sh
# du runner bloqué sur « Authentication »).
# Correctif documenté par Proxmox (Network Configuration → Masquerading) :
#   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
#
# Ce script :
#   1. ajoute la règle maintenant si elle manque (vérifiée avec iptables -C) ;
#   2. l'ajoute au bloc « iface nat » de /etc/network/interfaces (post-up /
#      post-down), après une copie de sauvegarde ;
#   3. valide le fichier avec « ifquery nat » et restaure la copie en cas d'échec.
# Il ne lance JAMAIS ifreload / ifup / ifdown : le réseau n'est pas redémarré.
#
# Seuls les CT avec firewall=1 passent par un pont fwbr : la prod (100, 401-404),
# sans pare-feu, n'est pas concernée.
#
# Retour arrière :
#   iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1
#   cp <copie affichée> /etc/network/interfaces
# Usage : bash infra/07-conntrack-zone.sh        Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

RULE=(-i 'fwbr+' -j CT --zone 1)
RULE_TEXT="iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1"
POST_UP="	post-up   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1"
POST_DOWN="	post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1"

require_root
require_pve
command -v ifquery >/dev/null || die "ifquery introuvable (ifupdown2 attendu sur Proxmox)."

title "État actuel"
grep -qE "^iface[[:space:]]+$FORGE_BRIDGE([[:space:]]|$)" "$IFACES_FILE" \
	|| die "Bloc « iface $FORGE_BRIDGE » introuvable dans $IFACES_FILE (bridge défini ailleurs ?). Abandon."
ok "Bloc « iface $FORGE_BRIDGE » présent dans $IFACES_FILE."
info "MASQUERADE actuels :"
iptables -t nat -S POSTROUTING | grep MASQUERADE | sed 's/^/    /' || warn "Aucune règle MASQUERADE : le NAT du bridge $FORGE_BRIDGE est-il configuré ?"

rule_live=0
iptables -t raw -C PREROUTING "${RULE[@]}" 2>/dev/null && rule_live=1
rule_file=0
grep -qF -- "-i fwbr+ -j CT --zone 1" "$IFACES_FILE" && rule_file=1
info "Règle active maintenant : $([[ $rule_live -eq 1 ]] && echo oui || echo non)"
info "Règle dans $IFACES_FILE : $([[ $rule_file -eq 1 ]] && echo oui || echo non)"

if [[ $rule_live -eq 1 && $rule_file -eq 1 ]]; then
	ok "Zone conntrack déjà en place : rien à faire."
	exit 0
fi

BACKUP="$IFACES_FILE.forge-bak-$(date +%Y%m%d-%H%M%S)"
title "Ce que le script va faire"
[[ $rule_live -eq 0 ]] && plan "$RULE_TEXT   (immédiat, sans redémarrer le réseau)"
if [[ $rule_file -eq 0 ]]; then
	plan "Copie de sauvegarde : $BACKUP"
	plan "Ajouter au bloc « iface $FORGE_BRIDGE » de $IFACES_FILE :"
	plan "  ${POST_UP#	}"
	plan "  ${POST_DOWN#	}"
	plan "Valider avec « ifquery $FORGE_BRIDGE » (restauration automatique en cas d'échec) ; pas d'ifreload"
fi
confirm "Appliquer ?"

if [[ $rule_live -eq 0 ]]; then
	run iptables -t raw -I PREROUTING "${RULE[@]}"
	ok "Règle active."
fi

if [[ $rule_file -eq 0 ]]; then
	ifaces_add_to_block "$FORGE_BRIDGE" "$BACKUP" "$POST_UP" "$POST_DOWN"
	sed 's/^/    /' <<<"$(ifquery "$FORGE_BRIDGE")"
fi

title "Terminé"
ok "Les CT avec pare-feu (firewall=1) sortent de nouveau par le MASQUERADE."
info "Retour arrière :"
plan "iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1"
[[ $rule_file -eq 0 ]] && plan "cp $BACKUP $IFACES_FILE"
info "Vérification depuis un CT de projet : curl -sI https://api.github.com | head -n1"
