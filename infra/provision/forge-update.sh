#!/usr/bin/env bash
# Installé DANS le CT 150 en /usr/local/sbin/forge-update (par infra/08-forge-updater.sh).
# Lancé par systemd (forge-update.path) dès que Forge dépose /opt/forge/updates/request.json.
#
#   1. vérifie l'archive (un seul dossier racine, aucun chemin absolu ni « .. ») ;
#   2. met l'arborescence actuelle de côté (/opt/forge.previous) et l'image (forge:previous) ;
#   3. installe la nouvelle arborescence (.env et updates/ conservés), docker compose build ;
#   4. docker compose up -d, puis attend que Forge réponde sur 127.0.0.1:3000 ;
#   5. en cas d'échec : remet l'arborescence et l'image précédentes, puis redémarre.
# La base (volume forge-data) n'est jamais touchée. Résultat : status.json, current.json, update.log.
set -Eeuo pipefail

APP=/opt/forge
DIR="$APP/updates"
REQ="$DIR/request.json"
WORK="$DIR/request.processing"
LOG="$DIR/update.log"
PREV="$APP.previous"
STAGING="$APP.staging"
MIN_MEM_KB=1800000

[[ -f "$REQ" ]] || exit 0
mv "$REQ" "$WORK"
: >"$LOG"
chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1

sha="$(jq -r '.sha // empty' "$WORK")"
file="$(jq -r '.file // empty' "$WORK")"
tree_moved=0
image_saved=0

status() {
	jq -n --arg state "$1" --arg sha "$sha" --arg message "$2" --arg at "$(date -Is)" '{state:$state, sha:$sha, message:$message, at:$at}' >"$DIR/status.json.part"
	chmod 644 "$DIR/status.json.part"
	mv "$DIR/status.json.part" "$DIR/status.json"
}
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

rollback() {
	if [[ $tree_moved -eq 1 ]]; then
		log "Retour à l'arborescence précédente…"
		find "$APP" -mindepth 1 -maxdepth 1 ! -name .env ! -name updates -exec rm -rf {} +
		find "$PREV" -mindepth 1 -maxdepth 1 -exec mv -t "$APP" {} +
	fi
	if [[ $image_saved -eq 1 ]]; then
		log "Retour à l'image précédente…"
		docker image tag forge:previous forge:local
		(cd "$APP" && docker compose up -d) || log "⚠ docker compose up -d a échoué : vérifiez à la main (cd $APP && docker compose up -d)."
	fi
}

fail() {
	trap - ERR
	set +e
	log "✖ $1"
	rollback
	status failed "$1"
	rm -f "$WORK"
	exit 1
}
trap 'fail "Erreur inattendue ligne $LINENO : $BASH_COMMAND"' ERR

[[ "$sha" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "Demande invalide (sha « $sha »)."
[[ "$file" =~ ^forge-[A-Za-z0-9._-]+\.tar\.gz$ && -f "$DIR/$file" ]] || fail "Archive introuvable ou nom invalide : $file"
status running "Vérification de l'archive"
log "Mise à jour de Forge vers ${sha:0:12} ($file)"

mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
if [[ "$mem_kb" -lt $MIN_MEM_KB ]]; then
	fail "Mémoire du CT insuffisante pour le build ($((mem_kb / 1024)) Mo). Sur l'hôte : pct set 150 --memory 2048 (c'est une limite, pas une réservation)."
fi

entries="$(tar -tzf "$DIR/$file")" || fail "Archive illisible."
roots="$(cut -d/ -f1 <<<"$entries" | sort -u | wc -l)"
[[ "$roots" -eq 1 ]] || fail "Archive inattendue : $roots dossiers racine."
if grep -qE '(^/|(^|/)\.\.(/|$))' <<<"$entries"; then fail "Archive refusée : chemin absolu ou « .. »."; fi

rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$DIR/$file" -C "$STAGING" --strip-components=1 --no-same-owner
rm -rf "$STAGING/.env" "$STAGING/updates" "$STAGING/data" "$STAGING/node_modules"
for f in Dockerfile docker-compose.yml package.json; do
	[[ -f "$STAGING/$f" ]] || fail "Archive incomplète : $f manquant."
done

status running "Mise de côté de la version actuelle"
if docker image inspect forge:local >/dev/null 2>&1; then
	docker image tag forge:local forge:previous
	image_saved=1
fi
rm -rf "$PREV"
mkdir -p "$PREV"
find "$APP" -mindepth 1 -maxdepth 1 ! -name .env ! -name updates -exec mv -t "$PREV" {} +
tree_moved=1
cp -a "$STAGING/." "$APP/"
rm -rf "$STAGING"

status running "docker compose build (quelques minutes)"
log "docker compose build…"
(cd "$APP" && docker compose build) || fail "Le build a échoué : version précédente conservée."

status running "Redémarrage du conteneur"
log "docker compose up -d…"
(cd "$APP" && docker compose up -d) || fail "docker compose up -d a échoué."

log "Attente de Forge sur 127.0.0.1:3000…"
for _ in $(seq 1 30); do
	if curl -fsS -o /dev/null -m 3 http://127.0.0.1:3000/login; then
		trap - ERR
		jq -n --arg sha "$sha" --arg at "$(date -Is)" '{sha:$sha, at:$at}' >"$DIR/current.json"
		chmod 644 "$DIR/current.json"
		status done "Forge ${sha:0:7} en service."
		rm -f "$WORK" "$DIR/$file"
		find "$DIR" -maxdepth 1 -name 'forge-*.tar.gz' -mmin +60 -delete
		docker image prune -f >/dev/null 2>&1 || true
		log "✔ Mise à jour terminée."
		exit 0
	fi
	sleep 2
done
fail "Forge ne répond pas après 60 s."
