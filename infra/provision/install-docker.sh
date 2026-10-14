#!/usr/bin/env bash
# Exécuté DANS un CT (via pct exec … bash -s). Installe Docker CE + plugin compose
# depuis le dépôt officiel Docker. Idempotent.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[docker] Mise à jour du système…"
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -qq ca-certificates curl gnupg jq git tar openssh-server iputils-ping unattended-upgrades

# Mises à jour de sécurité automatiques (dépôts « security » d'Ubuntu uniquement :
# Docker n'est pas mis à jour tout seul, pour éviter un redémarrage surprise des conteneurs).
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
systemctl enable unattended-upgrades >/dev/null 2>&1 || true

if ! command -v docker >/dev/null 2>&1; then
	echo "[docker] Ajout du dépôt officiel Docker…"
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	. /etc/os-release
	cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
	apt-get update -qq
	apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
	echo "[docker] Docker déjà installé : $(docker --version)"
fi

# Rotation des logs des conteneurs : les disques des CT sont petits (8–20 Go).
mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
	cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
fi
systemctl enable --now docker >/dev/null
systemctl restart docker
docker version --format '[docker] Moteur {{.Server.Version}} OK'
docker compose version
