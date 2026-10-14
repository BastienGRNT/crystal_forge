#!/usr/bin/env bash
# =============================================================================
# 03-template-docker-runner.sh — Template LXC 900 « tpl-docker-runner »
# -----------------------------------------------------------------------------
# Crée le CT 900 depuis Ubuntu 24.04 puis le convertit en template :
#   • unprivileged, features nesting=1,keyctl=1 (Docker dans LXC), bridge nat, pool forge
#   • disque 6 Go : un redimensionnement ne peut qu'AGRANDIR, et la plus petite
#     taille Forge (S) fait 8 Go
#   • Docker CE + plugin compose (dépôt officiel), rotation des logs
#   • utilisateur github (uid 1000, groupe docker, sans sudo)
#   • dernière version du runner GitHub dans /home/github/actions-runner,
#     vérifiée par SHA-256, NON configurée
#   • clé SSH publique de Forge pour root et github, connexion par mot de passe désactivée
#   • nettoyage : machine-id, clés d'hôte SSH (régénérées au boot), engine-id Docker
#   • protection=1 sur le template (empêche sa suppression accidentelle)
#
# Pendant l'installation, le CT utilise temporairement l'IP 10.10.10.59 (hors de
# la plage Forge 60-99), vérifiée libre avant de commencer. Dans le template, net0
# n'a plus d'IP : Forge en attribue une à chaque clone.
#
# Usage : bash infra/03-template-docker-runner.sh "<clé publique SSH de Forge>"
#         bash infra/03-template-docker-runner.sh /chemin/vers/forge.pub
#   La clé s'obtient dans Forge → Réglages → Clé SSH.
# Idempotent : si le CT 900 existe déjà sans être un template, le provisioning
# est relancé ; si c'est déjà un template, le script s'arrête.
# =============================================================================
source "$(dirname "$0")/lib.sh"

TPL_ID=900
TPL_NAME="tpl-docker-runner"
TMP_IP="10.10.10.59"

require_root
require_pve

[[ $# -eq 1 ]] || die "Usage : $0 \"ssh-ed25519 AAAA… forge\"   (ou un chemin vers le fichier .pub)"
pubkey="$1"
[[ -f "$pubkey" ]] && pubkey="$(<"$pubkey")"
pubkey="$(echo "$pubkey" | tr -d '\r' | head -n1)"
[[ "$pubkey" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || die "Clé publique SSH invalide."
assert_not_prod "$TPL_ID"

title "Vérifications"
[[ -f "/var/lib/vz/template/cache/$(basename "${FORGE_OSTEMPLATE#*:vztmpl/}")" ]] \
	|| die "Template OS introuvable : $FORGE_OSTEMPLATE (pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst)"
ok "Template OS : $FORGE_OSTEMPLATE"
pvesh get "/pools/$FORGE_POOL" --output-format json >/dev/null 2>&1 || die "Le pool $FORGE_POOL n’existe pas : lancez d’abord 02-proxmox-forge-access.sh."
ok "Pool $FORGE_POOL présent"

mode="create"
if ct_exists "$TPL_ID"; then
	if pct config "$TPL_ID" | grep -q '^template: 1'; then
		ok "Le CT $TPL_ID est déjà un template. Rien à faire."
		info "Pour le reconstruire : pct set $TPL_ID --protection 0 && pct destroy $TPL_ID, puis relancez ce script."
		exit 0
	fi
	hostname_now="$(pct config "$TPL_ID" | awk -F': ' '/^hostname/{print $2}')"
	[[ "$hostname_now" == "$TPL_NAME" ]] || die "Le CT $TPL_ID existe et s’appelle « $hostname_now », pas $TPL_NAME. Abandon."
	mode="resume"
	warn "Le CT $TPL_ID existe (non converti) : le provisioning sera relancé (idempotent)."
else
	vmid_exists "$TPL_ID" && die "L’ID $TPL_ID est déjà utilisé par une VM."
	assert_ip_free "$TMP_IP"
fi

title "Ce que le script va faire"
if [[ $mode == create ]]; then
	plan "pct create $TPL_ID ($TPL_NAME) : Ubuntu 24.04, unprivileged, nesting=1,keyctl=1, 2 cœurs, 2 Go, disque 6 Go sur $FORGE_STORAGE"
	plan "réseau temporaire : $FORGE_BRIDGE, $TMP_IP/24, passerelle $FORGE_GATEWAY — pool $FORGE_POOL"
fi
plan "Démarrer le CT, installer Docker CE + compose, utilisateur github, runner GitHub (non configuré)"
plan "Installer la clé SSH de Forge : ${pubkey:0:40}…"
plan "Nettoyer, retirer l’IP, arrêter, activer la protection et convertir en template"
confirm "Créer le template ?"

if [[ $mode == create ]]; then
	run pct create "$TPL_ID" "$FORGE_OSTEMPLATE" \
		--hostname "$TPL_NAME" \
		--unprivileged 1 \
		--features nesting=1,keyctl=1 \
		--cores 2 --memory 2048 --swap 512 \
		--rootfs "$FORGE_STORAGE:6" \
		--net0 "name=eth0,bridge=$FORGE_BRIDGE,ip=$TMP_IP/24,gw=$FORGE_GATEWAY" \
		--ostype ubuntu \
		--pool "$FORGE_POOL" \
		--onboot 0 \
		--tags forge-template \
		--description "Template Forge : Docker CE + runner GitHub (non configuré). Géré par infra/03-template-docker-runner.sh."
else
	run pct set "$TPL_ID" --net0 "name=eth0,bridge=$FORGE_BRIDGE,ip=$TMP_IP/24,gw=$FORGE_GATEWAY"
fi

if [[ "$(pct status "$TPL_ID")" != "status: running" ]]; then
	run pct start "$TPL_ID"
fi
wait_ct_network "$TPL_ID"

title "Installation de Docker"
ct_run_script "$TPL_ID" "$INFRA_DIR/provision/install-docker.sh"

title "Utilisateur github, SSH et runner"
ct_run_script "$TPL_ID" "$INFRA_DIR/provision/template-runner.sh" FORGE_PUBKEY="$pubkey"

title "Nettoyage et conversion"
ct_run_script "$TPL_ID" "$INFRA_DIR/provision/cleanup-template.sh"
run pct shutdown "$TPL_ID" --timeout 60
run pct set "$TPL_ID" --net0 "name=eth0,bridge=$FORGE_BRIDGE,ip=manual"
run pct template "$TPL_ID"
run pct set "$TPL_ID" --protection 1

ok "Template $TPL_ID ($TPL_NAME) prêt."
pct config "$TPL_ID" | sed 's/^/    /'
info "Membres du pool $FORGE_POOL :"
pvesh get "/pools/$FORGE_POOL" --output-format json | perl -MJSON::PP -e 'local $/; print "    $_->{id}\n" for @{decode_json(<STDIN>)->{members}}'
