#!/usr/bin/env bash
# Fonctions communes aux scripts infra/ de Forge.
# Ce fichier est « sourcé » par les autres scripts ; il ne fait rien tout seul.

set -Eeuo pipefail

# --- Constantes de l'infrastructure (relevées le 2026-10-14) ------------------
FORGE_NODE="${FORGE_NODE:-$(hostname)}"
FORGE_POOL="forge"
FORGE_BRIDGE="nat"
FORGE_GATEWAY="10.10.10.1"
FORGE_STORAGE="local"
FORGE_OSTEMPLATE="local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
# CT de production : aucun script ne doit les modifier.
PROD_CTIDS=(100 101 401 402 403 404)

# --- Affichage -----------------------------------------------------------------
if [[ -t 1 ]]; then
	C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
	C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_BLUE=$'\e[34m'; C_CYAN=$'\e[36m'
else
	C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

title() { printf '\n%s━━ %s ━━%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
info()  { printf '%s•%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()   { printf '%s✖ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }
plan()  { printf '  %s→%s %s\n' "$C_DIM" "$C_RESET" "$*"; }

trap 'die "Erreur ligne $LINENO (commande : $BASH_COMMAND). Rien d’autre n’a été exécuté après ce point."' ERR

# Affiche puis exécute une commande.
run() {
	printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
	"$@"
}

# Demande une confirmation explicite (« oui »). Toute autre réponse arrête le script.
confirm() {
	local prompt="${1:-Continuer ?}"
	if [[ "${FORGE_ASSUME_YES:-}" == "1" ]]; then
		warn "FORGE_ASSUME_YES=1 : confirmation automatique pour « $prompt »"
		return 0
	fi
	local answer
	read -r -p "$C_BOLD$prompt$C_RESET [tapez « oui » pour continuer] " answer
	[[ "$answer" == "oui" ]] || die "Annulé par l’utilisateur. Aucune modification supplémentaire."
}

# Question oui/non sans arrêter le script (retourne 0 pour oui).
ask_yes_no() {
	local answer
	read -r -p "$1 [o/N] " answer
	[[ "$answer" =~ ^[oOyY]$ ]]
}

require_root() {
	[[ $EUID -eq 0 ]] || die "Ce script doit être lancé en root sur l’hôte Proxmox."
}

require_pve() {
	command -v pveversion >/dev/null || die "pveversion introuvable : ce script doit tourner sur l’hôte Proxmox."
	command -v pct >/dev/null || die "pct introuvable."
	info "Proxmox : $(pveversion) — nœud $FORGE_NODE"
}

ct_exists() { pct status "$1" >/dev/null 2>&1; }
vmid_exists() { [[ -e "/etc/pve/nodes/$FORGE_NODE/lxc/$1.conf" || -e "/etc/pve/nodes/$FORGE_NODE/qemu-server/$1.conf" ]]; }

# Garde-fou : refuse toute opération sur un CT de production.
assert_not_prod() {
	local id="$1" p
	for p in "${PROD_CTIDS[@]}"; do
		[[ "$id" == "$p" ]] && die "Refus : le CT $id est un CT de production, ce script ne doit pas le toucher."
	done
	return 0
}

# Liste toutes les IPv4 déclarées dans la config réseau de TOUS les CT et VM.
used_ips() {
	grep -hoE 'ip=([0-9]{1,3}\.){3}[0-9]{1,3}' /etc/pve/nodes/*/lxc/*.conf /etc/pve/nodes/*/qemu-server/*.conf 2>/dev/null \
		| cut -d= -f2 | sort -u || true
}

# Vérifie qu'une IP n'est ni déclarée par un CT, ni répondant au ping.
assert_ip_free() {
	local ip="$1"
	if used_ips | grep -qx "$ip"; then
		die "L’IP $ip est déjà déclarée dans la config d’un CT/VM."
	fi
	if ping -c 1 -W 1 "$ip" >/dev/null 2>&1; then
		die "L’IP $ip répond au ping : elle est déjà utilisée par quelque chose."
	fi
	ok "IP $ip libre (aucune config, pas de réponse au ping)."
}

# Attend que le CT ait accès à Internet (pour apt / téléchargements).
wait_ct_network() {
	local id="$1" i
	info "Attente du réseau dans le CT $id…"
	for i in $(seq 1 60); do
		if pct exec "$id" -- bash -c 'getent hosts download.docker.com >/dev/null 2>&1 && ping -c1 -W1 1.1.1.1 >/dev/null 2>&1'; then
			ok "Réseau opérationnel dans le CT $id."
			return 0
		fi
		sleep 2
	done
	die "Le CT $id n’a pas accès au réseau après 120 s (vérifiez le bridge $FORGE_BRIDGE et le MASQUERADE)."
}

# Exécute un script local dans le CT (via stdin) en root.
ct_run_script() {
	local id="$1" script="$2"
	shift 2
	pct exec "$id" -- env DEBIAN_FRONTEND=noninteractive "$@" bash -s <"$script"
}

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
