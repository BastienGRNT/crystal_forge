#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — Installation de Forge en une commande (relançable)
# -----------------------------------------------------------------------------
# Enchaîne les scripts infra/ dans le bon ordre. Chaque script vérifie l'état
# réel et ne fait que ce qui manque (sinon : « rien à faire »), affiche son plan
# et demande « oui » avant d'écrire :
#   OS   template Ubuntu 24.04             (pveam download, si absent)
#   00a  bridge nat, NAT, 80/443 → NPM     (seulement ce qui manque)
#   00b  Tailscale, route 10.10.10.0/24    (seulement ce qui manque)
#   00c  CT 100 Nginx Proxy Manager        (si NPM ne répond pas sur 10.10.10.2:81)
#   01   sauvegarde quotidienne de la prod (si « forge-prod-daily » absent)
#   04   CT 150 qui héberge Forge          (si CT 150 absent)
#   08   déploiement de Forge + service de mise à jour (si Forge ne répond pas)
#   02   pool, utilisateur, jeton API      (si forge@pve absent) — remis directement à Forge
#   03   template 900 Docker + runner      (si CT 900 absent) — clé SSH lue dans Forge
#   05   pare-feu datacenter               (si désactivé)
#   07   zone conntrack fwbr+              (seulement ce qui manque)
#
# Le dépôt complet doit être sur l'hôte (ex. /root/crystal_forge) : 08 déploie
# Forge depuis le dossier parent de infra/.
# Usage : bash infra/bootstrap.sh ["ssh-ed25519 AAAA… forge"]   (clé : sinon lue dans Forge)
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve
PUBKEY="${1:-}"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
FORGE_URL="http://10.10.10.15:3000"

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

forge_up() { curl -fsS -o /dev/null -m 5 "$FORGE_URL/login" 2>/dev/null; }

OS_TPL="$(basename "${FORGE_OSTEMPLATE#*:vztmpl/}")"
if step OS "Template Ubuntu 24.04" '[[ -f "/var/lib/vz/template/cache/$OS_TPL" ]]'; then
	plan "pveam update && pveam download local $OS_TPL"
	confirm "Télécharger le template ?"
	run pveam update
	run pveam download local "$OS_TPL"
fi

title "00a · Réseau interne (bridge nat, NAT, 80/443 → NPM)"
bash "$INFRA_DIR/00a-network.sh"

title "00b · Tailscale (accès à Forge, NPM, Proxmox)"
bash "$INFRA_DIR/00b-tailscale.sh"

title "00c · Nginx Proxy Manager"
bash "$INFRA_DIR/00c-npm-ct.sh"

if step 01 "Sauvegarde quotidienne de la prod" '[[ "$(pvesh get /cluster/backup --output-format json | json_has forge-prod-daily)" == 1 ]]'; then
	bash "$INFRA_DIR/01-backup-job.sh"
fi

if step 04 "CT 150 de Forge" 'ct_exists 150'; then
	bash "$INFRA_DIR/04-forge-ct.sh"
fi

if step 08 "Déploiement de Forge et service de mise à jour" 'forge_up && pct exec 150 -- test -f /opt/forge/updates/updater.json'; then
	[[ -f "$REPO_DIR/Dockerfile" ]] || die "Dépôt complet introuvable dans $REPO_DIR : copiez tout crystal_forge sur l'hôte (pas seulement infra/)."
	bash "$INFRA_DIR/08-forge-updater.sh" --from "$REPO_DIR"
fi

if step 02 "Accès Proxmox de Forge (forge@pve)" '[[ "$(pvesh get /access/users --output-format json | json_has forge@pve)" == 1 ]]'; then
	FORGE_DELIVER_CT=150 bash "$INFRA_DIR/02-proxmox-forge-access.sh"
else
	info "Pour régénérer le jeton (et le remettre à Forge) : FORGE_DELIVER_CT=150 bash infra/02-proxmox-forge-access.sh"
fi

if step 03 "Template 900 (Docker + runner)" 'ct_exists 900'; then
	if [[ -z "$PUBKEY" ]]; then
		info "Lecture de la clé SSH publique de Forge (générée à son premier démarrage)…"
		for _ in $(seq 1 15); do
			PUBKEY="$(pct exec 150 -- cat /opt/forge/updates/forge.pub 2>/dev/null || true)"
			[[ -n "$PUBKEY" ]] && break
			sleep 2
		done
	fi
	[[ -n "$PUBKEY" ]] || die "Clé SSH de Forge introuvable (/opt/forge/updates/forge.pub dans le CT 150). Copiez-la depuis Réglages → Clé SSH et relancez : bash infra/bootstrap.sh \"ssh-ed25519 AAAA… forge\""
	ok "Clé de Forge : ${PUBKEY:0:40}…"
	bash "$INFRA_DIR/03-template-docker-runner.sh" "$PUBKEY"
fi

fw_enabled="$(pvesh get /cluster/firewall/options --output-format json | perl -MJSON::PP -e 'local $/; print decode_json(<STDIN>)->{enable} // 0')"
if step 05 "Pare-feu datacenter" '[[ "$fw_enabled" == 1 ]]'; then
	bash "$INFRA_DIR/05-firewall.sh"
fi

title "07 · Zone conntrack des ponts fwbr (NAT des CT avec pare-feu)"
bash "$INFRA_DIR/07-conntrack-zone.sh"

title "Terminé — infrastructure prête"
setup_line="$(pct exec 150 -- docker logs forge 2>&1 | grep -o "Jeton d'installation : .*" | tail -n1 || true)"
info "Il reste ce qui demande vos comptes ou un navigateur (via Tailscale) :"
plan "Console Tailscale : approuver la route 10.10.10.0/24 de $(hostname) (si ce n'est pas déjà fait)"
plan "NPM http://10.10.10.2:81 : compte admin, puis compte « Forge » non admin (docs/INSTALL.md §4)"
plan "Forge $FORGE_URL/setup : compte admin${setup_line:+ — $setup_line}"
plan "Forge → Réglages : jeton GitHub (§2), clés OVH (§3), compte NPM Forge (§4) — Proxmox et clé SSH sont déjà faits"
plan "Forge → Réglages → Tester les connexions, puis Santé du serveur ; premier déploiement en DRY-RUN"
