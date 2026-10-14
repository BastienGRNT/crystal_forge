#!/usr/bin/env bash
# =============================================================================
# 02-proxmox-forge-access.sh — Pool, utilisateur et jeton API de Forge
# -----------------------------------------------------------------------------
# Crée :
#   • le pool « forge » (seuls les CT de ce pool seront modifiables par Forge)
#   • l'utilisateur « forge@pve » (sans mot de passe : pas de connexion à l'UI)
#   • le jeton API « forge@pve!forge » avec séparation des privilèges (privsep=1)
#   • les ACL minimales, posées sur l'utilisateur ET sur le jeton
#     (avec privsep=1, les droits effectifs = intersection des deux) :
#
#       Chemin                          Rôle               Pourquoi
#       /                               PVEAuditor         lecture seule de tout (dashboard, IP libres)
#       /pool/forge                     PVEVMAdmin         gérer UNIQUEMENT les CT du pool (dont cloner le
#                                                          template 900 : VM.Clone, et créer : VM.Allocate)
#       /storage/local                  PVEDatastoreUser   allouer les disques des clones + vzdump
#       /sdn/zones/localnetwork/nat     PVESDNUser         utiliser le bridge « nat » (SDN.Use, PVE 8+/9)
#
# Privilèges vérifiés dans le source pve-container (PVE 9) :
#   POST /nodes/{node}/lxc/{vmid}/clone : VM.Clone sur /vms/900 + VM.Allocate sur
#     /pool/forge (paramètre pool requis) + Datastore.AllocateSpace sur le stockage
#     + SDN.Use sur le bridge. Le clone recopie « features » sans revérifier root@pam.
#   PUT  /nodes/{node}/lxc/{vmid}/config : VM.Config.{Disk,CPU,Memory,Network,Options}
#     (selon les clés) + SDN.Use si net0 change. « features » reste réservé à root@pam.
#
# Ce que Forge NE PEUT PAS faire avec ces droits :
#   • modifier/arrêter/supprimer un CT hors du pool (100, 101, 401-404…) ;
#   • ajouter un CT existant à son pool (il faudrait Pool.Allocate) ;
#   • brancher un CT sur vmbr0 (SDN.Use limité au bridge « nat ») ;
#   • modifier les permissions, les utilisateurs, le stockage ou l'hôte.
#
# Usage : bash infra/02-proxmox-forge-access.sh
# Idempotent. Le secret du jeton n'est affiché qu'à sa création (Proxmox ne le
# stocke qu'en hash) : si le jeton existe déjà, le script propose de le régénérer.
# =============================================================================
source "$(dirname "$0")/lib.sh"

PVE_USER="forge@pve"
TOKEN_NAME="forge"
TOKEN_ID="$PVE_USER!$TOKEN_NAME"
SDN_PATH="/sdn/zones/localnetwork/$FORGE_BRIDGE"

ACLS=(
	"/|PVEAuditor"
	"/pool/$FORGE_POOL|PVEVMAdmin"
	"/storage/$FORGE_STORAGE|PVEDatastoreUser"
	"$SDN_PATH|PVESDNUser"
)

require_root
require_pve

json_field() { perl -MJSON::PP -e 'local $/; my $j=decode_json(<STDIN>); my @k=split /\./, $ARGV[0]; for (@k){ $j = ref $j eq "ARRAY" ? $j->[$_] : $j->{$_} } print defined $j ? (ref $j ? encode_json($j) : $j) : ""' "$1"; }

title "État actuel"
pool_exists=0
pvesh get "/pools/$FORGE_POOL" --output-format json >/dev/null 2>&1 && pool_exists=1
user_exists=0
pveum user list --output-format json | perl -MJSON::PP -e 'local $/; exit !(grep { $_->{userid} eq $ARGV[0] } @{decode_json(<STDIN>)})' "$PVE_USER" && user_exists=1
token_exists=0
if [[ $user_exists -eq 1 ]] && pveum user token list "$PVE_USER" --output-format json | perl -MJSON::PP -e 'local $/; exit !(grep { $_->{tokenid} eq $ARGV[0] } @{decode_json(<STDIN>)})' "$TOKEN_NAME"; then
	token_exists=1
fi
info "Pool $FORGE_POOL : $([[ $pool_exists -eq 1 ]] && echo présent || echo absent)"
info "Utilisateur $PVE_USER : $([[ $user_exists -eq 1 ]] && echo présent || echo absent)"
info "Jeton $TOKEN_ID : $([[ $token_exists -eq 1 ]] && echo présent || echo absent)"

# Garde-fou : aucun CT de production ne doit être dans le pool forge.
if [[ $pool_exists -eq 1 ]]; then
	members="$(pvesh get "/pools/$FORGE_POOL" --output-format json | perl -MJSON::PP -e 'local $/; print join(" ", map { $_->{vmid} // () } @{decode_json(<STDIN>)->{members}})')"
	info "Membres actuels du pool : ${members:-aucun}"
	for p in "${PROD_CTIDS[@]}"; do
		for m in $members; do
			[[ "$m" == "$p" ]] && die "Le CT de production $p est dans le pool $FORGE_POOL ! Retirez-le d’abord (pvesh set /pools/$FORGE_POOL --vms $p --delete 1). Abandon."
		done
	done
	ok "Aucun CT de production dans le pool."
fi

regen_token=0
if [[ $token_exists -eq 1 ]]; then
	warn "Le jeton existe déjà ; son secret ne peut pas être réaffiché."
	if ask_yes_no "Régénérer le jeton (l’ancien secret cessera de fonctionner) ?"; then
		regen_token=1
	fi
fi

title "Ce que le script va faire"
[[ $pool_exists -eq 0 ]] && plan "Créer le pool $FORGE_POOL"
[[ $user_exists -eq 0 ]] && plan "Créer l’utilisateur $PVE_USER (sans mot de passe)"
[[ $token_exists -eq 0 ]] && plan "Créer le jeton $TOKEN_ID (privsep=1, sans expiration)"
[[ $regen_token -eq 1 ]] && plan "Supprimer puis recréer le jeton $TOKEN_ID"
for acl in "${ACLS[@]}"; do
	plan "ACL ${acl%%|*} → ${acl##*|} pour $PVE_USER et $TOKEN_ID"
done
confirm "Appliquer ?"

if [[ $pool_exists -eq 0 ]]; then
	run pveum pool add "$FORGE_POOL" --comment "CT gérés par Forge (seuls modifiables par forge@pve)"
fi
if [[ $user_exists -eq 0 ]]; then
	run pveum user add "$PVE_USER" --comment "Forge — mini-PaaS (jeton API uniquement)"
fi
if [[ $regen_token -eq 1 ]]; then
	run pveum user token remove "$PVE_USER" "$TOKEN_NAME"
	token_exists=0
fi
token_secret=""
if [[ $token_exists -eq 0 ]]; then
	printf '  %s$ pveum user token add %s %s --privsep 1 …%s\n' "$C_DIM" "$PVE_USER" "$TOKEN_NAME" "$C_RESET"
	token_json="$(pveum user token add "$PVE_USER" "$TOKEN_NAME" --privsep 1 --comment "Forge" --output-format json)"
	token_secret="$(json_field value <<<"$token_json")"
	[[ -n "$token_secret" ]] || die "Impossible de lire le secret du jeton."
fi

for acl in "${ACLS[@]}"; do
	path="${acl%%|*}"
	role="${acl##*|}"
	run pveum acl modify "$path" --roles "$role" --users "$PVE_USER" --tokens "$TOKEN_ID" --propagate 1
done
ok "ACL appliquées."

title "Vérification des droits effectifs du jeton"
check_priv() {
	local path="$1" priv="$2"
	pveum user token permissions "$PVE_USER" "$TOKEN_NAME" --path "$path" --output-format json 2>/dev/null \
		| perl -MJSON::PP -e 'local $/; my $j=decode_json(<STDIN>); my %p = map { %{$_} } values %$j; exit !exists $p{$ARGV[0]}' "$priv"
}
for id in "${PROD_CTIDS[@]}"; do
	if check_priv "/vms/$id" VM.Allocate || check_priv "/vms/$id" VM.PowerMgmt || check_priv "/vms/$id" VM.Config.Options; then
		die "Le jeton a un droit d’écriture sur le CT $id ! Vérifiez les ACL (pveum acl list). NE PAS utiliser ce jeton."
	fi
	ok "CT $id : lecture seule (ni VM.Allocate, ni VM.PowerMgmt, ni VM.Config.*)"
done
if check_priv "/pool/$FORGE_POOL" VM.Allocate && check_priv "/pool/$FORGE_POOL" VM.Clone; then
	ok "Pool $FORGE_POOL : VM.Allocate + VM.Clone présents"
else
	warn "Le jeton n’a pas VM.Allocate/VM.Clone sur /pool/$FORGE_POOL — vérifiez."
fi
if check_priv "$SDN_PATH" SDN.Use; then ok "Bridge $FORGE_BRIDGE : SDN.Use présent"; else warn "SDN.Use manquant sur $SDN_PATH"; fi
if check_priv "/sdn/zones/localnetwork/vmbr0" SDN.Use; then
	warn "Le jeton peut utiliser vmbr0 : une ACL plus large existe ailleurs."
else
	ok "Bridge vmbr0 : interdit (SDN.Use absent)"
fi
if check_priv "/storage/$FORGE_STORAGE" Datastore.AllocateSpace; then ok "Stockage $FORGE_STORAGE : Datastore.AllocateSpace présent"; fi

title "À coller dans Forge → Réglages → Proxmox"
echo "  URL            : https://$FORGE_GATEWAY:8006"
echo "  Nœud           : $FORGE_NODE"
echo "  ID du jeton    : $TOKEN_ID"
if [[ -n "$token_secret" ]]; then
	echo "  Secret         : ${C_BOLD}$token_secret${C_RESET}"
	warn "Ce secret ne sera plus jamais affiché. Copiez-le maintenant."
else
	echo "  Secret         : (inchangé — relancez le script et régénérez le jeton si vous l’avez perdu)"
fi
echo
echo "  Certificat CA de Proxmox (pour vérifier le TLS au lieu de l’ignorer) :"
sed 's/^/    /' /etc/pve/pve-root-ca.pem
