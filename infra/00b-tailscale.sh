#!/usr/bin/env bash
# =============================================================================
# 00b-tailscale.sh — Tailscale sur l'hôte, routeur du sous-réseau des CT
# -----------------------------------------------------------------------------
# Forge, NPM (:81) et les CT ne sont joignables QUE via Tailscale. Ce script :
#   • installe Tailscale depuis son dépôt apt officiel (si absent) ;
#   • connecte l'hôte (lien de connexion à ouvrir, ou TS_AUTHKEY_FILE=<fichier>) en
#     annonçant la route 10.10.10.0/24 ; --accept-dns=false sur un nœud neuf, pour
#     que l'hôte (et les CT, qui héritent de son resolv.conf) gardent leurs DNS ;
#   • si l'hôte est déjà connecté : ajoute seulement la route si elle manque
#     (tailscale set, les autres réglages ne changent pas).
# Avec le SNAT par défaut du routeur de sous-réseau, vos requêtes arrivent sur les
# CT avec l'adresse 10.10.10.1 (d'où les règles de Forge et du CT 150).
#
# Reste manuel : approuver la route dans la console Tailscale (Machines → l'hôte →
# Edit route settings), sauf si vos ACL ont un autoApprovers pour 10.10.10.0/24.
# Usage : bash infra/00b-tailscale.sh   (TS_AUTHKEY_FILE=/root/ts.key pour une clé)
# Idempotent.
# =============================================================================
source "$(dirname "$0")/lib.sh"

ROUTE="10.10.10.0/24"

require_root
require_pve

json_get() { perl -MJSON::PP -e 'local $/; my $j=eval { decode_json(<STDIN>) } // {}; my $v=$j; $v = ref $v eq "HASH" ? $v->{$_} : undef for split /\./, $ARGV[0]; print ref $v eq "ARRAY" ? join(",", @$v) : ($v // "")' "$1"; }

title "État actuel"
installed=0
command -v tailscale >/dev/null && installed=1
state=""
routes=""
if [[ $installed -eq 1 ]]; then
	state="$(tailscale status --json 2>/dev/null | json_get BackendState || true)"
	routes="$(tailscale debug prefs 2>/dev/null | json_get AdvertiseRoutes || true)"
fi
info "Tailscale installé : $([[ $installed -eq 1 ]] && echo oui || echo non)"
info "État : ${state:-inconnu}"
info "Routes annoncées : ${routes:-aucune}"

route_ok=0
[[ ",$routes," == *",$ROUTE,"* ]] && route_ok=1
if [[ $installed -eq 1 && "$state" == Running && $route_ok -eq 1 ]]; then
	ok "Tailscale connecté et route $ROUTE annoncée : rien à faire."
	info "Vérifiez qu'elle est approuvée dans la console Tailscale (Machines → $(hostname))."
	exit 0
fi

. /etc/os-release
title "Ce que le script va faire"
[[ $installed -eq 0 ]] && plan "Ajouter le dépôt apt pkgs.tailscale.com (debian/$VERSION_CODENAME) et installer tailscale"
if [[ "$state" == Running ]]; then
	plan "tailscale set --advertise-routes=${routes:+$routes,}$ROUTE   (les autres réglages ne changent pas)"
else
	plan "tailscale up --advertise-routes=$ROUTE --accept-dns=false${TS_AUTHKEY_FILE:+ --auth-key=file:$TS_AUTHKEY_FILE}"
	[[ -z "${TS_AUTHKEY_FILE:-}" ]] && plan "un lien de connexion s'affichera : ouvrez-le pour ajouter l'hôte à votre tailnet"
fi
confirm "Appliquer ?"

if [[ $installed -eq 0 ]]; then
	run curl -fsSL "https://pkgs.tailscale.com/stable/debian/$VERSION_CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
	run curl -fsSL "https://pkgs.tailscale.com/stable/debian/$VERSION_CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
	run apt-get update -qq
	run apt-get install -y -qq tailscale
	run systemctl enable --now tailscaled
fi
# Le routeur de sous-réseau a besoin du routage IPv4 (posé aussi par 00a).
sysctl -n net.ipv4.ip_forward | grep -qx 1 || warn "net.ipv4.ip_forward=0 : lancez d'abord infra/00a-network.sh."

if [[ "$state" == Running ]]; then
	run tailscale set --advertise-routes="${routes:+$routes,}$ROUTE"
else
	if [[ -n "${TS_AUTHKEY_FILE:-}" ]]; then
		[[ -f "$TS_AUTHKEY_FILE" ]] || die "TS_AUTHKEY_FILE introuvable : $TS_AUTHKEY_FILE"
		run tailscale up --advertise-routes="$ROUTE" --accept-dns=false --auth-key="file:$TS_AUTHKEY_FILE"
	else
		run tailscale up --advertise-routes="$ROUTE" --accept-dns=false
	fi
fi

title "Terminé"
tailscale ip -4 | sed 's/^/    IP Tailscale de l’hôte : /'
warn "Approuvez la route $ROUTE dans la console Tailscale (Machines → $(hostname) → Edit route settings)."
info "Ensuite, depuis votre PC (Tailscale actif) : Forge http://10.10.10.15:3000, NPM http://10.10.10.2:81, Proxmox https://<IP Tailscale de l'hôte>:8006."
