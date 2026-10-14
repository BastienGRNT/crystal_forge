#!/usr/bin/env bash
# =============================================================================
# 05-firewall.sh — Active le pare-feu Proxmox au niveau datacenter, SANS filtrer l'hôte
# -----------------------------------------------------------------------------
# Les règles par CT que pose Forge (isolement de chaque projet sur le bridge
# « nat ») ne s'appliquent que si le pare-feu est activé au niveau datacenter.
# Ce script :
#   1. met les politiques du datacenter à ACCEPT (entrée ET sortie) : l'hôte
#      lui-même n'est PAS filtré (8006, SSH, Tailscale, NAT restent ouverts) ;
#   2. active le pare-feu datacenter (enable=1) ;
#   3. arme un retour arrière automatique (désactivation dans 3 min) que vous
#      annulez après avoir vérifié que vous avez toujours accès à l'hôte ;
#   4. vérifie que les règles NAT (MASQUERADE / DNAT 80-443 vers NPM) et celles
#      de Tailscale sont toujours là.
#
# Aucun CT n'est modifié. Les CT de prod (100, 401-404) n'ont pas de pare-feu
# activé : leur trafic ne change pas. Seuls les CT où Forge active le pare-feu
# (pool forge) sont filtrés.
#
# Si le pare-feu datacenter est DÉJÀ actif, le script ne change rien (vous l'avez
# configuré vous-même). Avec policy_in=DROP, le CT 150 ne joint alors pas l'API
# Proxmox (8006) : relancez infra/04-forge-ct.sh, qui ajoute la règle du nœud.
#
# Avec firewall=1, les CT de projet sortent par un pont fwbr : lancez aussi
# infra/07-conntrack-zone.sh, sinon ils n'ont plus Internet (NAT).
#
# Retour arrière manuel : pvesh set /cluster/firewall/options --enable 0
# Usage : bash infra/05-firewall.sh        Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve

ROLLBACK_UNIT="forge-firewall-rollback"
SNAP_DIR="$(mktemp -d)"

title "État actuel"
pvesh get /cluster/firewall/options --output-format json-pretty | sed 's/^/    /'
current_enable="$(pvesh get /cluster/firewall/options --output-format json | perl -MJSON::PP -e 'local $/; print decode_json(<STDIN>)->{enable} // 0')"
current_in="$(pvesh get /cluster/firewall/options --output-format json | perl -MJSON::PP -e 'local $/; print decode_json(<STDIN>)->{policy_in} // "DROP (par défaut)"')"

iptables-save -t nat >"$SNAP_DIR/nat.before" 2>/dev/null || true
nat_rules=$(grep -cE -- '-j (MASQUERADE|DNAT|SNAT)' "$SNAP_DIR/nat.before" || true)
ts_rules=$(iptables-save 2>/dev/null | grep -c 'ts-' || true)
info "Règles NAT actuelles (MASQUERADE/DNAT/SNAT) : $nat_rules"
info "Règles Tailscale (chaînes ts-*) : $ts_rules"

if [[ "$current_enable" == "1" && "$current_in" == "ACCEPT" ]]; then
	ok "Pare-feu datacenter déjà actif avec policy_in=ACCEPT : rien à faire."
	exit 0
fi
if [[ "$current_enable" == "1" ]]; then
	warn "Le pare-feu datacenter est DÉJÀ actif avec policy_in=$current_in. Ce script ne le modifie pas : vous l'avez configuré vous-même."
	plan "L'hôte n'accepte 8006 que depuis local_network : pour que Forge (CT 150) joigne l'API, relancez bash infra/04-forge-ct.sh (règle du nœud)."
	plan "NAT des CT avec pare-feu : bash infra/07-conntrack-zone.sh"
	exit 0
fi

title "Plan"
plan "pvesh set /cluster/firewall/options --policy_in ACCEPT --policy_out ACCEPT"
plan "systemd-run : retour arrière automatique dans 3 min (enable=0) si vous ne confirmez pas"
plan "pvesh set /cluster/firewall/options --enable 1"
plan "vérification des règles NAT et Tailscale"
echo
warn "Gardez une deuxième session SSH ouverte vers l'hôte pendant l'opération."
confirm "Activer le pare-feu du datacenter (hôte non filtré) ?"

title "Activation"
run pvesh set /cluster/firewall/options --policy_in ACCEPT --policy_out ACCEPT
systemctl stop "$ROLLBACK_UNIT.timer" >/dev/null 2>&1 || true
run systemd-run --quiet --unit="$ROLLBACK_UNIT" --on-active=180 /usr/bin/pvesh set /cluster/firewall/options --enable 0
run pvesh set /cluster/firewall/options --enable 1
info "Attente de l'application des règles par pve-firewall (10 s)…"
sleep 10
pve-firewall status | sed 's/^/    /' || true

title "Vérifications"
iptables-save -t nat >"$SNAP_DIR/nat.after" 2>/dev/null || true
nat_after=$(grep -cE -- '-j (MASQUERADE|DNAT|SNAT)' "$SNAP_DIR/nat.after" || true)
ts_after=$(iptables-save 2>/dev/null | grep -c 'ts-' || true)
[[ "$nat_after" -ge "$nat_rules" ]] && ok "Règles NAT intactes ($nat_after)." || warn "Règles NAT : $nat_rules avant, $nat_after après ! (diff ci-dessous)"
[[ "$nat_after" -ge "$nat_rules" ]] || diff "$SNAP_DIR/nat.before" "$SNAP_DIR/nat.after" | sed 's/^/    /' || true
[[ "$ts_after" -ge "$ts_rules" ]] && ok "Règles Tailscale intactes ($ts_after)." || warn "Règles Tailscale : $ts_rules avant, $ts_after après !"

echo
warn "Vérifiez MAINTENANT depuis votre PC : l'interface Proxmox (8006), le SSH, Forge et un site de prod."
if ask_yes_no "Tout fonctionne ? (sinon, le pare-feu se désactivera tout seul dans moins de 3 min)"; then
	run systemctl stop "$ROLLBACK_UNIT.timer"
	ok "Pare-feu datacenter actif, retour arrière annulé."
	info "Étape suivante, pour que les CT avec pare-feu gardent Internet : bash infra/07-conntrack-zone.sh"
	info "Dans Forge : Santé du serveur → « Appliquer le pare-feu » pour isoler les CT de projet existants."
else
	run pvesh set /cluster/firewall/options --enable 0
	systemctl stop "$ROLLBACK_UNIT.timer" >/dev/null 2>&1 || true
	warn "Pare-feu désactivé (retour à l'état initial)."
fi
rm -rf "$SNAP_DIR"
