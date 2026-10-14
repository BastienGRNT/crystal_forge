#!/usr/bin/env bash
# Exécuté DANS le CT 900 (via pct exec … bash -s), après install-docker.sh.
# Variables attendues : FORGE_PUBKEY (clé publique SSH de Forge).
# Idempotent.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
: "${FORGE_PUBKEY:?FORGE_PUBKEY manquant}"

RUNNER_DIR=/home/github/actions-runner

# --- Utilisateur github (uid 1000, groupe docker, AUCUN sudo) ------------------
# Forge lance svc.sh en root via SSH : github n'a pas besoin de sudo. Un sudo
# « limité à svc.sh » serait illusoire (svc.sh appartient à github, et le groupe
# docker équivaut déjà à root).
if ! id github >/dev/null 2>&1; then
	if getent passwd 1000 >/dev/null; then
		echo "[runner] L'uid 1000 est déjà pris par $(getent passwd 1000 | cut -d: -f1)" >&2
		exit 1
	fi
	useradd --create-home --uid 1000 --shell /bin/bash github
fi
usermod -aG docker github
echo "[runner] Utilisateur github : $(id github)"

# --- Clés SSH de Forge (root + github) -----------------------------------------
install_key() {
	local home="$1" owner="$2"
	install -d -m 700 -o "$owner" -g "$owner" "$home/.ssh"
	touch "$home/.ssh/authorized_keys"
	grep -qxF "$FORGE_PUBKEY" "$home/.ssh/authorized_keys" || echo "$FORGE_PUBKEY" >>"$home/.ssh/authorized_keys"
	chown "$owner:$owner" "$home/.ssh/authorized_keys"
	chmod 600 "$home/.ssh/authorized_keys"
}
install_key /root root
install_key /home/github github

cat >/etc/ssh/sshd_config.d/10-forge.conf <<'EOF'
# Forge : authentification par clé uniquement.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF

# Ubuntu 24.04 démarre sshd par activation de socket ; on revient à un service
# classique pour pouvoir régénérer les clés d'hôte AVANT son démarrage.
if systemctl list-unit-files ssh.socket >/dev/null 2>&1; then
	systemctl disable --now ssh.socket >/dev/null 2>&1 || true
	rm -f /etc/systemd/system/ssh.service.d/00-socket.conf /etc/systemd/system/ssh.socket.d/addresses.conf
fi
cat >/etc/systemd/system/forge-ssh-hostkeys.service <<'EOF'
[Unit]
Description=Forge — régénère les clés d'hôte SSH au premier démarrage d'un clone
Before=ssh.service
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable forge-ssh-hostkeys.service ssh.service >/dev/null
systemctl restart ssh.service

# --- Runner GitHub (téléchargé, NON configuré) ----------------------------------
release_json="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
version="$(jq -r .tag_name <<<"$release_json" | sed 's/^v//')"
expected_sha="$(jq -r .body <<<"$release_json" | sed -n 's/.*<!-- BEGIN SHA linux-x64 -->\([0-9a-f]\{64\}\)<!-- END SHA linux-x64 -->.*/\1/p' | head -n1)"
archive="actions-runner-linux-x64-${version}.tar.gz"

if [[ -x "$RUNNER_DIR/config.sh" ]] && [[ -f "$RUNNER_DIR/.forge-version" ]] && [[ "$(cat "$RUNNER_DIR/.forge-version")" == "$version" ]]; then
	echo "[runner] Runner $version déjà présent."
else
	echo "[runner] Téléchargement du runner $version…"
	tmp="$(mktemp -d)"
	curl -fsSL -o "$tmp/$archive" "https://github.com/actions/runner/releases/download/v${version}/${archive}"
	if [[ -n "$expected_sha" ]]; then
		echo "$expected_sha  $tmp/$archive" | sha256sum -c -
	else
		echo "[runner] ⚠ Empreinte SHA-256 introuvable dans les notes de version : vérification ignorée." >&2
	fi
	install -d -o github -g github "$RUNNER_DIR"
	tar -xzf "$tmp/$archive" -C "$RUNNER_DIR"
	echo "$version" >"$RUNNER_DIR/.forge-version"
	chown -R github:github "$RUNNER_DIR"
	rm -rf "$tmp"
fi
# Dépendances système du runner (libicu, etc.).
"$RUNNER_DIR/bin/installdependencies.sh" >/dev/null
[[ -f "$RUNNER_DIR/.runner" ]] && { echo "[runner] ERREUR : le runner est configuré dans le template !" >&2; exit 1; }
echo "[runner] Runner $version prêt dans $RUNNER_DIR (non configuré)."
