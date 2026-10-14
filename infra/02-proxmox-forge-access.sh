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
#       /pool/forge                     PVEPoolUser        Pool.Audit : voir à quel pool appartient chaque CT
#       /storage/local                  PVEDatastoreUser   allouer les disques des clones + vzdump
#       /sdn/zones/localnetwork/nat     PVESDNUser         utiliser le bridge « nat » (SDN.Use, PVE 8+/9)
#
# ⚠ Une ACL posée sur /pool/forge REMPLACE, pour ce chemin, les rôles hérités de
#   « / » (PVEAuditor) : sans PVEPoolUser, le jeton n'a pas Pool.Audit sur le pool,
#   et Proxmox retire le champ « pool » de GET /cluster/resources (PVE/API2/Cluster.pm).
#   Forge croit alors le template et les CT hors du pool, et le garde refuse tout.
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
#         FORGE_SECRET_FILE=/root/forge-token.txt bash infra/02-proxmox-forge-access.sh
#   Avec FORGE_SECRET_FILE, le secret est écrit dans ce fichier (mode 600) au lieu
#   d'être affiché dans le terminal (historique, enregistrement de session…).
#         FORGE_DELIVER_CT=150 bash infra/02-proxmox-forge-access.sh   (utilisé par bootstrap.sh)
#   Avec FORGE_DELIVER_CT, l'URL, le nœud, le jeton, le CA et les CT de production
#   (PROD_CTIDS) sont remis directement à Forge (fichier provision.json du CT 150, lu sur l'entrée standard de pct exec,
#   jamais en argument) : Forge les importe, chiffrés, puis supprime le fichier.
# Idempotent. Le secret du jeton n'est affiché qu'à sa création (Proxmox ne le
# stocke qu'en hash) : si le jeton existe déjà, le script propose de le régénérer.
# =============================================================================
source "$(dirname "$0")/lib.sh"

PVE_USER="forge@pve"
TOKEN_NAME="forge"
TOKEN_ID="$PVE_USER!$TOKEN_NAME"
SDN_PATH="/sdn/zones/localnetwork/$FORGE_BRIDGE"
SECRET_FILE="${FORGE_SECRET_FILE:-}"
DELIVER_CT="${FORGE_DELIVER_CT:-}"

ACLS=(
	"/|PVEAuditor"
	"/pool/$FORGE_POOL|PVEVMAdmin"
	"/pool/$FORGE_POOL|PVEPoolUser"
	"/storage/$FORGE_STORAGE|PVEDatastoreUser"
	"$SDN_PATH|PVESDNUser"
)

require_root
require_pve

if [[ -n "$SECRET_FILE" ]]; then
	[[ "$SECRET_FILE" == /* ]] || die "FORGE_SECRET_FILE doit être un chemin absolu."
	[[ -d "$(dirname "$SECRET_FILE")" ]] || die "Dossier introuvable : $(dirname "$SECRET_FILE")"
	[[ -e "$SECRET_FILE" ]] && die "$SECRET_FILE existe déjà : supprimez-le (shred -u) ou choisissez un autre chemin."
fi

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
# Privilèges effectifs du jeton sur un chemin, hors *.Audit (lecture seule).
# Échec de lecture = échec du script : on ne conclut jamais « lecture seule » à l'aveugle.
non_audit_privs() {
	pveum user token permissions "$PVE_USER" "$TOKEN_NAME" --path "$1" --output-format json \
		| perl -MJSON::PP -e 'local $/; my $j=decode_json(<STDIN>); my %p = map { %{$_} } values %$j; print join(" ", sort grep { !/\.Audit$/ } keys %p)'
}
for id in "${PROD_CTIDS[@]}"; do
	privs="$(non_audit_privs "/vms/$id")" || die "Impossible de lire les droits du jeton sur /vms/$id. NE PAS utiliser ce jeton avant d’avoir vérifié."
	if [[ -n "$privs" ]]; then
		die "Le jeton a des droits au-delà de la lecture sur le CT $id : $privs ! Vérifiez les ACL (pveum acl list). NE PAS utiliser ce jeton."
	fi
	ok "CT $id : lecture seule (uniquement des privilèges *.Audit)"
done
if check_priv "/pool/$FORGE_POOL" VM.Allocate && check_priv "/pool/$FORGE_POOL" VM.Clone; then
	ok "Pool $FORGE_POOL : VM.Allocate + VM.Clone présents"
else
	warn "Le jeton n’a pas VM.Allocate/VM.Clone sur /pool/$FORGE_POOL — vérifiez."
fi
if check_priv "/pool/$FORGE_POOL" Pool.Audit; then
	ok "Pool $FORGE_POOL : Pool.Audit présent (Proxmox renvoie le champ « pool » des CT)"
else
	warn "Pool.Audit manquant sur /pool/$FORGE_POOL : Forge verra le template et les CT hors du pool."
	plan "pveum acl modify /pool/$FORGE_POOL --roles PVEPoolUser --users $PVE_USER --tokens '$TOKEN_ID' --propagate 1"
fi
if check_priv "$SDN_PATH" SDN.Use; then ok "Bridge $FORGE_BRIDGE : SDN.Use présent"; else warn "SDN.Use manquant sur $SDN_PATH"; fi
if check_priv "/sdn/zones/localnetwork/vmbr0" SDN.Use; then
	warn "Le jeton peut utiliser vmbr0 : une ACL plus large existe ailleurs."
else
	ok "Bridge vmbr0 : interdit (SDN.Use absent)"
fi
if check_priv "/storage/$FORGE_STORAGE" Datastore.AllocateSpace; then ok "Stockage $FORGE_STORAGE : Datastore.AllocateSpace présent"; fi

# Remise directe à Forge (CT 150) : aucun copier-coller, le secret n'est pas affiché.
# Les CT de production (PROD_CTIDS de lib.sh, source unique) sont remis à chaque fois ;
# le secret seulement s'il vient d'être créé (vide sinon : Forge garde le sien).
delivered=0
if [[ -n "$DELIVER_CT" ]]; then
	if pct exec "$DELIVER_CT" -- test -d /opt/forge/updates 2>/dev/null; then
		printf '  %s$ pct exec %s -- … > /opt/forge/updates/provision.json (jeton, CA, CT protégés, via stdin)%s\n' "$C_DIM" "$DELIVER_CT" "$C_RESET"
		perl -MJSON::PP -e 'local $/; my $ca = do { open my $f, "<", "/etc/pve/pve-root-ca.pem" or die; <$f> }; my %h = ("proxmox.url" => $ARGV[0], "proxmox.node" => $ARGV[1], "proxmox.tokenId" => $ARGV[2], "safety.protectedCtids" => $ARGV[3], "proxmox.tokenSecret" => <STDIN>, "proxmox.caCert" => $ca); $h{"proxmox.tokenSecret"} =~ s/\s+\z//; print encode_json(\%h)' \
			"https://$FORGE_GATEWAY:8006" "$FORGE_NODE" "$TOKEN_ID" "$(IFS=,; echo "${PROD_CTIDS[*]}")" <<<"$token_secret" \
			| pct exec "$DELIVER_CT" -- bash -c 'umask 077 && cat >/opt/forge/updates/provision.json.part && chown 1000:1000 /opt/forge/updates/provision.json.part && mv /opt/forge/updates/provision.json.part /opt/forge/updates/provision.json'
		ok "CT de production protégés remis à Forge : ${PROD_CTIDS[*]}."
		if [[ -n "$token_secret" ]]; then
			delivered=1
			ok "Jeton et CA remis à Forge (CT $DELIVER_CT) : importés automatiquement sous 10 s, puis le fichier est supprimé."
		fi
	else
		warn "Forge n'est pas encore déployé sur le CT $DELIVER_CT (/opt/forge/updates absent)${token_secret:+ : secret affiché ci-dessous}."
	fi
fi

title "À coller dans Forge → Réglages → Proxmox"
echo "  URL            : https://$FORGE_GATEWAY:8006"
echo "  Nœud           : $FORGE_NODE"
echo "  ID du jeton    : $TOKEN_ID"
echo "  CT protégés    : $(IFS=,; echo "${PROD_CTIDS[*]}")   (Réglages → Réseau)"
if [[ $delivered -eq 1 ]]; then
	echo "  Secret         : remis directement à Forge (non affiché)"
elif [[ -n "$token_secret" && -n "$SECRET_FILE" ]]; then
	(umask 077 && printf '%s\n' "$token_secret" >"$SECRET_FILE")
	chmod 600 "$SECRET_FILE"
	echo "  Secret         : écrit dans $SECRET_FILE (mode 600, non affiché)"
	warn "Après l’avoir collé dans Forge, supprimez le fichier : shred -u $SECRET_FILE"
elif [[ -n "$token_secret" ]]; then
	echo "  Secret         : ${C_BOLD}$token_secret${C_RESET}"
	warn "Ce secret ne sera plus jamais affiché. Copiez-le maintenant."
	info "Pour ne pas l’afficher la prochaine fois : FORGE_SECRET_FILE=/root/forge-token.txt bash $0"
else
	echo "  Secret         : (inchangé — relancez le script et régénérez le jeton si vous l’avez perdu)"
fi
if [[ $delivered -eq 0 ]]; then
	echo
	echo "  Certificat CA de Proxmox (pour vérifier le TLS au lieu de l’ignorer) :"
	sed 's/^/    /' /etc/pve/pve-root-ca.pem
fi
