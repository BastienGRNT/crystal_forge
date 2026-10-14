#!/usr/bin/env bash
# =============================================================================
# 06-migrate-db.sh — Copie la base d'une app existante vers son nouveau projet Forge
# -----------------------------------------------------------------------------
# Pour migrer une app de prod (ex. CT 402 crystalwallet) vers un projet Forge :
#   1. créez le projet dans Forge depuis le même dépôt (nouveau CT, domaine de test) ;
#   2. lancez ce script sur l'hôte :  bash infra/06-migrate-db.sh 402 503
#      → dump de la base dans le CT source (LECTURE SEULE : pg_dump / mysqldump),
#      → copie du dump dans les sauvegardes du projet Forge (CT destination) ;
#   3. dans Forge : projet → Base de données → Sauvegardes → « Restaurer » sur la
#      ligne « Importée » (double confirmation, état actuel sauvegardé d'abord) ;
#   4. vérifiez l'app sur le domaine de test, puis basculez le domaine.
#
# Le CT source n'est jamais modifié. Le CT destination doit être un CT Forge
# (pool « forge », hors prod). Les fichiers hors base (uploads, volumes) ne sont
# pas copiés : la liste des volumes du CT source est affichée pour un rsync manuel.
#
# Usage : bash infra/06-migrate-db.sh <ctid-source> <ctid-destination> [conteneur-source]
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root
require_pve
SRC="${1:-}"; DST="${2:-}"; SRC_CTR="${3:-}"
[[ "$SRC" =~ ^[0-9]+$ && "$DST" =~ ^[0-9]+$ ]] || die "Usage : bash infra/06-migrate-db.sh <ctid-source> <ctid-destination> [conteneur-source]"
[[ "$SRC" != "$DST" ]] || die "Source et destination identiques."
ct_exists "$SRC" || die "CT source $SRC introuvable."
ct_exists "$DST" || die "CT destination $DST introuvable."
assert_not_prod "$DST"

title "Vérifications"
dst_pool="$(pvesh get /cluster/resources --type vm --output-format json | perl -MJSON::PP -e 'local $/; my $id=shift; for (@{decode_json(<STDIN>)}) { print $_->{pool} // "" if $_->{vmid}==$id }' "$DST")"
[[ "$dst_pool" == "$FORGE_POOL" ]] || die "Le CT $DST n'est pas dans le pool « $FORGE_POOL » : ce n'est pas un projet Forge."
slug="$(pct config "$DST" | awk -F': ' '/^hostname/{print $2}')"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "Hostname du CT $DST inattendu : $slug"
[[ "$(pct status "$SRC")" == *running* ]] || die "Le CT source $SRC doit être démarré."
[[ "$(pct status "$DST")" == *running* ]] || die "Le CT destination $DST doit être démarré."
ok "Destination : CT $DST, projet Forge « $slug »."

# Conteneurs de base de données du CT source.
mapfile -t dbs < <(pct exec "$SRC" -- docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(^|\/)(postgres|postgis|timescaledb|pgvector|mysql|mariadb|percona)(:|$)/ {print $1" "$2}')
if [[ -z "$SRC_CTR" ]]; then
	[[ ${#dbs[@]} -gt 0 ]] || die "Aucun conteneur PostgreSQL / MySQL / MariaDB démarré dans le CT $SRC."
	[[ ${#dbs[@]} -eq 1 ]] || { printf '    %s\n' "${dbs[@]}"; die "Plusieurs bases : précisez le conteneur en 3e argument."; }
	SRC_CTR="${dbs[0]%% *}"
fi
image="$(pct exec "$SRC" -- docker inspect -f '{{.Config.Image}}' "$SRC_CTR")" || die "Conteneur $SRC_CTR introuvable dans le CT $SRC."
case "$image" in
	*postgres*|*postgis*|*timescale*|*pgvector*) kind=postgres ;;
	*mariadb*|*mysql*|*percona*) kind=mysql ;;
	*) die "Image non prise en charge : $image" ;;
esac
ok "Source : CT $SRC, conteneur « $SRC_CTR » ($image, $kind)."

# Mêmes commandes que Forge (identifiants lus dans l'environnement du conteneur).
if [[ "$kind" == postgres ]]; then
	DUMP='U="${POSTGRES_USER:-postgres}"; D="${POSTGRES_DB:-$U}"; exec pg_dump -U "$U" --clean --if-exists --no-owner --no-privileges "$D"'
else
	DUMP='U=root; P="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"; if [ -z "$P" ]; then U="${MARIADB_USER:-$MYSQL_USER}"; P="${MARIADB_PASSWORD:-$MYSQL_PASSWORD}"; fi; D="${MARIADB_DATABASE:-$MYSQL_DATABASE}"; export MYSQL_PWD="$P"; DUMPBIN="$(command -v mariadb-dump || command -v mysqldump)"; exec "$DUMPBIN" -u"$U" --single-transaction --routines --triggers --add-drop-table "$D"'
fi

name="$(date -u +%Y%m%d-%H%M%S)-import.sql.gz"
tmp="$(mktemp --suffix=.sql.gz)"
trap 'rm -f "$tmp"' EXIT

title "Plan"
plan "pct exec $SRC -- docker exec $SRC_CTR sh -c '<dump>' | gzip > $tmp   (lecture seule)"
plan "pct push $DST $tmp /home/github/forge-backups/$slug/$name   (propriétaire github, 0600)"
confirm "Copier la base ?"

title "Dump"
pct exec "$SRC" -- docker exec "$SRC_CTR" sh -c "$DUMP" | gzip >"$tmp"
gzip -t "$tmp" || die "Dump invalide."
size=$(stat -c %s "$tmp")
[[ "$size" -gt 100 ]] || die "Dump vide ($size octets) : vérifiez les identifiants du conteneur source."
ok "Dump : $((size / 1024)) Ko."

title "Copie"
pct exec "$DST" -- install -d -o 1000 -g 1000 -m 0700 "/home/github/forge-backups/$slug"
run pct push "$DST" "$tmp" "/home/github/forge-backups/$slug/$name" --user 1000 --group 1000 --perms 0600
ok "Copié dans le CT $DST : $name"

title "Fichiers hors base"
pct exec "$SRC" -- docker ps --format '{{.Names}}' | while read -r c; do
	pct exec "$SRC" -- docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} → {{.Destination}}{{"\n"}}{{end}}' "$c" | sed "/^$/d; s/^/    $c : /"
done
info "Ces volumes ne sont pas copiés. Si l'app stocke des fichiers (uploads…), copiez-les avec rsync."

title "Suite"
info "Forge → projet « $slug » → Base de données → Sauvegardes → Restaurer « $name »."
