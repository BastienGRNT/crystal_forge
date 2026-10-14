#!/usr/bin/env bash
# Exécuté DANS le CT 900 juste avant sa conversion en template.
# Supprime tout ce qui doit être unique par clone.
set -Eeuo pipefail

systemctl stop docker docker.socket containerd >/dev/null 2>&1 || true

# Identifiant de machine : regénéré par systemd au premier boot du clone.
: >/etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -sf /etc/machine-id /var/lib/dbus/machine-id

# Clés d'hôte SSH : regénérées par forge-ssh-hostkeys.service au premier boot.
rm -f /etc/ssh/ssh_host_*

# Identifiant du moteur Docker (sinon tous les clones partagent le même).
rm -f /var/lib/docker/engine-id

# Caches, historiques et journaux.
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /home/github/.cache
rm -f /root/.bash_history /home/github/.bash_history
find /var/log -type f -name '*.gz' -delete
find /var/log -type f -exec truncate -s 0 {} +
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true

echo "[cleanup] Template nettoyé."
