#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — Installation de Forge en une commande (relançable)
# -----------------------------------------------------------------------------
# Enchaîne les scripts infra/ dans le bon ordre et SAUTE ce qui est déjà fait :
#   01  job de sauvegarde de la prod   (si « forge-prod-daily » absent)
#   02  pool, utilisateur et jeton API (si forge@pve absent)
#   04  CT 150 qui héberge Forge       (si CT 150 absent)
#   03  template 900 Docker + runner   (si CT 900 absent ; nécessite la clé SSH de Forge)
#   05  pare-feu datacenter            (si désactivé)
# Chaque script affiche son plan et demande « oui » avant d'écrire.
#
# Usage :
#   bash infra/bootstrap.sh                       # 1er passage (01, 02, 04)
#   bash infra/bootstrap.sh "ssh-ed25519 AAAA…"   # après avoir généré la clé dans Forge (03, 05)
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve
PUBKEY="${1:-}"

json_has() { perl -MJSON::PP -e 'local $/; my $j=decode_json(<STDIN>); my $k=shift; print((grep { ($_->{id}//$_->{userid}//"") eq $k } @$j) ? 1 : 0)' "$1"; }

step() {
	local num="$1" label="$2" done_check="$3"
	title "$num · $label"
	if eval "$done_check"; then
		ok "Déjà fait : étape sautée."
		return 1
	fi
	return 0
}

if step 01 "Sauvegarde quotidienne de la prod" '[[ "$(pvesh get /cluster/backup --output-format json | json_has forge-prod-daily)" == 1 ]]'; then
	bash "$INFRA_DIR/01-backup-job.sh"
fi

if step 02 "Accès Proxmox de Forge (forge@pve)" '[[ "$(pvesh get /access/users --output-format json | json_has forge@pve)" == 1 ]]'; then
	bash "$INFRA_DIR/02-proxmox-forge-access.sh"
else
	info "Pour régénérer le jeton : bash infra/02-proxmox-forge-access.sh"
fi

if step 04 "CT 150 de Forge" 'ct_exists 150'; then
	bash "$INFRA_DIR/04-forge-ct.sh"
fi

if step 03 "Template 900 (Docker + runner)" 'ct_exists 900'; then
	if [[ -z "$PUBKEY" ]]; then
		warn "Il faut d'abord la clé SSH de Forge :"
		plan "déployez Forge sur le CT 150 (docs/INSTALL.md §5), créez le compte admin ;"
		plan "Réglages → Clé SSH → Générer, copiez la clé publique ;"
		plan "relancez : bash infra/bootstrap.sh \"ssh-ed25519 AAAA… forge\""
		exit 0
	fi
	bash "$INFRA_DIR/03-template-docker-runner.sh" "$PUBKEY"
fi

fw_enabled="$(pvesh get /cluster/firewall/options --output-format json | perl -MJSON::PP -e 'local $/; print decode_json(<STDIN>)->{enable} // 0')"
if step 05 "Pare-feu datacenter" '[[ "$fw_enabled" == 1 ]]'; then
	bash "$INFRA_DIR/05-firewall.sh"
fi

title "Terminé"
ok "Infrastructure prête. Dans Forge : Réglages → Tester les connexions, puis Santé du serveur."
