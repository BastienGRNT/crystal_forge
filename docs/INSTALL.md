# Installer Forge

**En une commande** : `bash infra/bootstrap.sh` enchaîne les scripts ci-dessous dans l'ordre et saute ce qui est déjà fait. Un premier passage installe 01, 02 et 04. Relancez-le ensuite avec la clé publique de Forge : `bash infra/bootstrap.sh "ssh-ed25519 AAAA… forge"` installe 03, 05 et 07.

Ordre détaillé (chaque étape est réversible, aucune ne touche aux CT existants) :

1. `infra/01-backup-job.sh` : sauvegardes quotidiennes de la prod (à faire en premier).
2. `infra/02-proxmox-forge-access.sh` : pool `forge`, utilisateur `forge@pve`, jeton API.
3. `infra/04-forge-ct.sh` : CT 150 qui hébergera Forge.
4. Déployer Forge sur le CT 150 (section 5), créer le compte admin, **générer la clé SSH** dans Réglages.
5. `infra/03-template-docker-runner.sh "<clé publique>"` : template 900.
6. Créer le jeton GitHub, les clés OVH et le compte NPM (sections 2 à 4), les saisir dans Réglages.
7. `infra/05-firewall.sh` : active le pare-feu Proxmox du datacenter, sans filtrer l'hôte, pour que l'isolement par CT s'applique. Puis `infra/07-conntrack-zone.sh` : sans lui, les CT avec pare-feu n'ont plus Internet.
8. **Réglages → Tester les connexions** : tout doit être vert, et la matrice doit montrer que les CT de prod sont en lecture seule. Ensuite, **Santé du serveur** doit être au vert.
9. Faire un premier déploiement **en DRY-RUN** (par défaut), lire le journal, puis passer `DRY_RUN=false`.
10. `infra/08-forge-updater.sh` : active le bouton **Réglages → Mise à jour** (section 5).

En cas de problème, voir la section **Dépannage** à la fin.

> Tous les scripts `infra/` affichent ce qu'ils vont faire et demandent de taper `oui`.
> Copiez le dossier `infra/` sur l'hôte (`scp -r infra root@100.77.79.45:/root/forge-infra`) et lancez-les en root.

---

## 1. Scripts Proxmox

### 1.1 Sauvegardes — `01-backup-job.sh`

```bash
bash infra/01-backup-job.sh
```

Crée le job `forge-prod-daily` (03:30, zstd, `keep-daily=7`) pour les CT 100, 401, 402, 403 et 404, et propose une première sauvegarde immédiate.

À savoir :

- le mode `snapshot` n'existe pas sur un stockage `dir` : Proxmox **bascule tout seul en mode `suspend`**. Le CT est gelé quelques secondes, ce qui reste cohérent pour Postgres ;
- en mode `suspend`, vzdump recopie d'abord **tout le CT** dans un dossier temporaire, `/var/tmp` par défaut, qui est sur `/` (21 Go seulement). Le CT 402 (~14 Go) suffit à remplir le disque de l'hôte. Le job et la sauvegarde immédiate passent donc `--tmpdir /var/lib/vz/dump`, le dossier du stockage `local` ;
- `keep-daily=7` élague **aussi les sauvegardes manuelles** des mêmes CT (un `vzdump` lancé à la main, la sauvegarde initiale…). Seules les sauvegardes protégées y échappent. À la fin, le script liste celles qui ne viennent pas du job et propose de les protéger :

  ```bash
  pvesh set /nodes/ns3125740/storage/local/content/<volid> --protected 1
  ```

  Une sauvegarde protégée n'est jamais élaguée ; pour la supprimer, retirez d'abord la protection (`--protected 0`) ;
- les notes des sauvegardes utilisent `-` et non `—` : le tiret long provoquait « Wide character in print » et une note mal encodée dans `jobs.cfg` ;
- les sauvegardes sont sur **le même disque** que les CT. Elles protègent d'une erreur, pas d'une panne disque. Prévoyez une copie externe : Proxmox Backup Server, OVH Backup Storage, ou un `rclone` des fichiers `/var/lib/vz/dump/*.zst`.

### 1.2 Accès de Forge — `02-proxmox-forge-access.sh`

```bash
bash infra/02-proxmox-forge-access.sh
```

ACL posées sur l'utilisateur **et** sur le jeton (`privsep=1` : les droits effectifs sont l'intersection des deux) :

| Chemin | Rôle | Pourquoi |
|---|---|---|
| `/` | PVEAuditor | lecture seule de tout (dashboard, calcul des IP libres) |
| `/pool/forge` | PVEVMAdmin | gérer uniquement les CT du pool, dont le clone du template 900 |
| `/pool/forge` | PVEPoolUser | `Pool.Audit` : savoir à quel pool appartient chaque CT |
| `/storage/local` | PVEDatastoreUser | allouer les disques des clones, vzdump |
| `/sdn/zones/localnetwork/nat` | PVESDNUser | utiliser le bridge `nat` uniquement (pas `vmbr0`) |

**Pourquoi PVEPoolUser ?** Une ACL posée sur un chemin **remplace**, pour ce chemin, les rôles hérités du parent. Sur `/pool/forge`, `PVEVMAdmin` remplace donc le `PVEAuditor` hérité de `/`, et le jeton perd `Pool.Audit`. Or, sans `Pool.Audit`, Proxmox retire le champ `pool` de `GET /cluster/resources` (`PVE/API2/Cluster.pm`). Forge voit alors le template « hors du pool » et le garde refuse toute action (« n'est pas dans le pool »). Rattrapage, pour un jeton créé avant ce correctif :

```bash
pveum acl modify /pool/forge --roles PVEPoolUser --users forge@pve --tokens 'forge@pve!forge' --propagate 1
```

`PVEPoolUser` ne contient que `Pool.Audit` : aucun droit d'écriture en plus.

Ces privilèges ont été vérifiés dans le source de `pve-container` (PVE 9) :

- `POST /lxc/{vmid}/clone` exige `VM.Clone` sur le template, `VM.Allocate` sur `/pool/forge` (avec le paramètre `pool`), `Datastore.AllocateSpace` et `SDN.Use` sur le bridge. La config, y compris `features: nesting`, est recopiée sans revérifier les droits root.
- `PUT /lxc/{vmid}/config` exige `VM.Config.*` selon les clés modifiées. `features` reste réservé à `root@pam`, c'est pourquoi Forge clone un template plutôt que de créer depuis l'ostemplate.

À la fin, le script vérifie que le jeton n'a, sur 100, 101 et 401-404, **aucun privilège autre que `*.Audit`** : tous les privilèges sont contrôlés, pas seulement quelques-uns, et une lecture impossible arrête le script. Il vérifie aussi `Pool.Audit` sur le pool. Il affiche ensuite le secret du jeton (une seule fois) et le certificat CA de Proxmox, à coller dans Réglages → Proxmox.

Pour ne pas afficher le secret dans le terminal (historique, enregistrement de session), écrivez-le dans un fichier en mode 600, puis supprimez ce fichier après l'avoir collé :

```bash
FORGE_SECRET_FILE=/root/forge-token.txt bash infra/02-proxmox-forge-access.sh
shred -u /root/forge-token.txt
```

**TLS** : collez `/etc/pve/pve-root-ca.pem` (le CA), pas `pve-ssl.pem`. Le certificat de l'API ne contient pas `10.10.10.1` dans ses SAN, seulement l'IP publique, `ns3125740` et `localhost`. C'est sans effet : avec un CA, Forge vérifie la chaîne de certificats mais pas le nom d'hôte (`checkServerIdentity` désactivé). Sans CA, la vérification TLS est désactivée, et le test de connexion le signale. Changer l'URL, le jeton ou le CA reconstruit le client Proxmox : aucun ancien réglage TLS ne reste en cache.

### 1.3 CT de Forge — `04-forge-ct.sh`

```bash
bash infra/04-forge-ct.sh
```

Crée le CT 150 `forge` : 10.10.10.15, 1 cœur, 1 Go, 8 Go, Docker, **hors du pool forge** (Forge ne peut pas se supprimer lui-même).

Il installe aussi un pare-feu : le port 3000 n'est accepté que depuis `10.10.10.1` (l'hôte : avec Tailscale en routeur de sous-réseau, vos requêtes arrivent avec cette adresse source à cause du SNAT) et `100.64.0.0/10`. Les autres CT du bridge, dont les apps de prod, ne peuvent pas joindre Forge.

**Pare-feu du datacenter déjà actif** : avec `enable=1` et `policy_in=DROP` (la valeur par défaut), l'hôte n'accepte le port 8006 que depuis `local_network`, c'est-à-dire le /24 de l'IP publique (`pve-firewall localnet`). Le CT 150 ne joint donc pas l'API (« Proxmox injoignable »). Dans ce cas, le script ajoute, de façon idempotente et après l'avoir affichée dans le plan, une règle sur le pare-feu **du nœud**, qui ne fait qu'ouvrir ce port :

```bash
pvesh create /nodes/ns3125740/firewall/rules --type in --action ACCEPT --source 10.10.10.15 --proto tcp --dport 8006 --enable 1 --comment "Forge (CT 150) -> API Proxmox"
```

### 1.4 Template — `03-template-docker-runner.sh`

À lancer **après** avoir généré la clé SSH dans Forge (Réglages → Clé SSH → Générer) :

```bash
bash infra/03-template-docker-runner.sh "ssh-ed25519 AAAA… forge"
```

Le script crée le CT 900 et le convertit en template :

- disque de 6 Go : un redimensionnement ne peut qu'agrandir, et la taille S fait 8 Go ;
- Docker CE + compose, avec rotation des logs ;
- utilisateur `github` (uid 1000, groupe docker), **sans sudo** : Forge lance `svc.sh` en root par SSH ;
- runner GitHub (dernière version, SHA-256 vérifié) téléchargé mais non configuré ;
- clé de Forge installée pour root et github, connexion par mot de passe désactivée ;
- clés d'hôte SSH et `machine-id` régénérées au premier boot de chaque clone ;
- `protection=1` sur le template.

**Protection héritée par les clones** : Proxmox recopie `protection=1` dans chaque clone. Le rollback et la suppression d'un projet échouaient alors (« CT is protected » / « protection mode enabled »). Forge applique désormais `protection: 0` à l'étape « Conteneur ». Avant une suppression, il retire aussi, via le garde, la protection d'un CT de son pool. Pour un clone créé avant ce correctif, vous pouvez la retirer à la main, **uniquement sur un CT de projet (500-599)**, jamais sur la prod :

```bash
pct set 503 --protection 0
```

**DNS des clones** : sans réglage, un clone hérite du `resolv.conf` de l'hôte, ici Tailscale MagicDNS (`100.100.100.100`). Cela fonctionne, mais dépend de Tailscale. Pour fixer les résolveurs, renseignez **Réglages → Réseau → DNS des CT de projet** (par exemple `1.1.1.1 9.9.9.9`). Ils sont appliqués (`nameserver`) à la configuration de chaque CT, à chaque déploiement. Le champ est vide par défaut.

### 1.5 Pare-feu — `05-firewall.sh`

```bash
bash infra/05-firewall.sh
```

Sans ce script, tous les CT du bridge `nat` se voient : un projet Forge peut joindre les bases de données de la prod. Forge pose sur **chaque CT de projet** les règles suivantes :

- en entrée, NPM → port de l'app, Forge (10.10.10.15) → SSH, et l'hôte (Tailscale) ; tout le reste est rejeté (`policy_in=DROP`) ;
- en sortie, seule la passerelle est autorisée sur le bridge : la prod et les autres projets sont injoignables, Internet reste accessible ;
- l'anti-usurpation IP (`ipfilter`).

Ces règles ne s'appliquent que si le pare-feu est activé **au niveau datacenter**. C'est ce que fait le script, avec des précautions :

- les politiques du datacenter passent d'abord à `ACCEPT` : l'hôte n'est pas filtré (8006, SSH, Tailscale, NAT) ;
- un **retour arrière automatique** (désactivation au bout de 3 min) est armé ; vous l'annulez après avoir vérifié que tout répond ;
- les règles NAT et Tailscale sont comparées avant et après l'activation.

Les CT de prod n'ont pas le pare-feu activé : leur trafic ne change pas. Droits : poser des règles sur un CT exige `VM.Config.Network` sur `/vms/<id>`, déjà donné par `PVEVMAdmin` sur le pool (vérifié dans le source de `pve-firewall`).

Pour les projets créés avant, utilisez **Santé du serveur → Appliquer le pare-feu**, ou l'onglet Conteneur du projet.

**Pare-feu datacenter déjà actif** : si `enable=1`, le script s'arrête sans rien modifier, puisque vous l'avez configuré vous-même. Vérifiez alors deux points : la règle 8006 du CT 150 (relancez `infra/04-forge-ct.sh`, voir 1.3) et la zone conntrack (1.6).

### 1.6 NAT des CT avec pare-feu — `07-conntrack-zone.sh`

```bash
bash infra/07-conntrack-zone.sh
```

Avec `firewall=1` sur `net0`, le trafic du CT traverse le pont `fwbr<id>i0`, et le suivi de connexion (conntrack) est décidé sur ce pont : la règle `MASQUERADE -o vmbr0` du bridge `nat` ne s'applique plus. Les paquets sortent avec leur source `10.10.10.x` et le CT n'a plus Internet. Le runner reste alors bloqué sur « Authentication ». Correctif documenté par Proxmox (*Network Configuration → Masquerading*) :

```
iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
```

Le script :

- ajoute la règle tout de suite si elle manque (vérification par `iptables -C`) ;
- l'ajoute au bloc `iface nat` de `/etc/network/interfaces`, après une copie de sauvegarde :

  ```
  	post-up   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
  	post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1
  ```

- valide le fichier avec `ifquery nat` et restaure la copie en cas d'échec. Il ne lance **jamais** `ifreload` : le réseau n'est pas redémarré ;
- affiche le retour arrière (`iptables -t raw -D …` et la copie à remettre en place).

Seuls les CT avec pare-feu passent par un pont `fwbr` : la prod n'est pas concernée. Côté Forge, le déploiement teste l'accès Internet du CT juste après l'étape Pare-feu et s'arrête avec un message clair si GitHub est injoignable. `config.sh` est aussi coupé au bout de 150 s au lieu de rester bloqué. **Santé du serveur** vérifie que chaque CT du pool avec pare-feu joint `https://api.github.com`.

---

## 2. Jeton GitHub (fine-grained)

GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate new token* :

- **Resource owner** : `BastienGRNT`
- **Repository access** : *All repositories* (pour lister les dépôts dans l'assistant), ou *Only select repositories*
- **Expiration** : à votre convenance (Forge affiche la date d'expiration dans le test de connexion)
- **Repository permissions** :

| Permission | Accès | Utilisé pour |
|---|---|---|
| **Administration** | **Read and write** | jeton d'enregistrement / retrait du runner |
| Secrets | Read and write | secret `ENV_FILE` |
| Variables | Read and write | variables `FORGE_*` |
| Actions | Read and write | lancer et suivre les runs |
| Contents | Read and write | commit de `forge-deploy.yml` |
| Workflows | Read and write | obligatoire pour écrire dans `.github/workflows` |
| Metadata | Read-only | obligatoire |

**Administration en « Read and write » est indispensable.** Sans elle, ou si le dépôt n'est pas inclus dans *Repository access*, la création du jeton d'enregistrement du runner échoue avec « Resource not accessible by personal access token ». Le test de connexion vérifie la lecture (liste des runners d'un dépôt) ; l'écriture ne peut être vérifiée qu'au premier déploiement, sans créer de jeton.

Pour le bouton **Mettre à jour Forge**, le jeton doit aussi pouvoir lire le dépôt `crystal_forge` (*Contents : Read*, déjà couvert si le dépôt est inclus).

Collez le jeton (`github_pat_…`) dans Réglages → GitHub.

## 3. Clés OVH

Ouvrez le lien **createToken** proposé dans Réglages → OVH : il est généré pour vos zones. Les zones doivent être **celles que gère réellement ce compte OVH** : le test de connexion les liste. Une zone d'un autre compte, même saisie dans l'assistant, est refusée par Forge (« n'est pas gérée par ce compte OVH ») et aucun enregistrement n'est créé. L'exemple ci-dessous, pour `bastiengrnt.fr` et `pharmagaia.com`, ne vaut que si les deux sont sur ce compte :

```
https://eu.api.ovh.com/createToken/?GET=/domain/zone&GET=/auth/currentCredential
  &GET=/domain/zone/bastiengrnt.fr/record&GET=/domain/zone/bastiengrnt.fr/record/*
  &POST=/domain/zone/bastiengrnt.fr/record&POST=/domain/zone/bastiengrnt.fr/refresh
  &DELETE=/domain/zone/bastiengrnt.fr/record/*
  &GET=/domain/zone/pharmagaia.com/record&…
```

- **Ne donnez jamais `POST /domain/zone/*`** : cette règle couvre aussi `/reset`, qui vide la zone, et `/import`. Le test de connexion signale ce genre de règle.
- Le `DELETE` sur `/record/*` est optionnel. Sans lui, le rollback et le retrait d'un domaine vous indiqueront l'enregistrement à supprimer à la main.
- Forge ne crée que des enregistrements **A** vers `51.68.180.212`, et seulement si aucun A, AAAA ou CNAME n'existe déjà pour ce nom.

Reportez l'Application key, l'Application secret et la Consumer key dans Réglages → OVH.

## 4. Compte NPM dédié

Dans l'admin NPM (`http://10.10.10.2:81`) → Users → **Add user** :

- **Name** : Forge — **Email** : votre adresse réelle. NPM 2.16 utilise l'email du compte pour Let's Encrypt.
- **Roles** : **pas** administrateur.
- **Permissions** : Proxy hosts → *Manage*, Certificates → *Manage*, tout le reste → *Hidden*, **Visibility → All items**. La visibilité « All » permet au dashboard de voir les proxy hosts de prod ; Forge s'interdit lui-même de toucher à ce qu'il n'a pas créé.
- Définissez un mot de passe et **n'activez pas la 2FA** sur ce compte, sinon `POST /api/tokens` exige un code.

Reportez l'email et le mot de passe dans Réglages → NPM.

Le test de connexion **signale un compte administrateur**. N'en utilisez pas : une fois `DRY_RUN=false`, un compte admin peut modifier ou supprimer **tous** les proxy hosts, y compris ceux de la prod, et changer les utilisateurs ou les réglages de NPM. Forge s'interdit de toucher à ce qu'il n'a pas créé, mais c'est le compte non admin qui borne réellement ce qu'une erreur ou un jeton volé peut faire.

## 5. Déployer Forge sur le CT 150

Depuis votre PC, via Tailscale :

```bash
rsync -a --exclude node_modules --exclude .svelte-kit --exclude build --exclude data ./ root@10.10.10.15:/opt/forge/
ssh root@10.10.10.15
cd /opt/forge
cp .env.example .env
sed -i "s|^FORGE_MASTER_KEY=.*|FORGE_MASTER_KEY=$(openssl rand -base64 32)|" .env
docker compose up -d --build
docker compose logs forge | grep "Jeton d'installation"
```

Ouvrez `http://10.10.10.15:3000`, collez le jeton d'installation et choisissez le mot de passe admin (argon2id, 12 caractères minimum).

**Sauvegardez `FORGE_MASTER_KEY`** dans votre gestionnaire de mots de passe : sans elle, les jetons et les `.env` stockés sont illisibles. La base SQLite est dans le volume `forge-data` (`/data/forge.db`).

**Variante depuis l'hôte Proxmox**, sans rsync ni git (git n'est pas forcément installé sur l'hôte). Copiez d'abord le dépôt dans `/root/crystal_forge`, puis :

```bash
tar -C /root/crystal_forge --exclude=node_modules --exclude=.svelte-kit --exclude=build --exclude=data --exclude=.git -cf - . | pct exec 150 -- tar -C /opt/forge -xf -
pct exec 150 -- bash -c 'cd /opt/forge && docker compose up -d --build'
```

Le build (vite) peut manquer de mémoire avec 1 Go. Passez la limite à 2 Go pendant le build (`pct set 150 --memory 2048`), puis revenez à 1 Go (`pct set 150 --memory 1024`). Pour un CT, c'est une limite et non une réservation : la garder à 2 Go ne coûte rien au repos. **Ne reconstruisez pas pendant un déploiement** : le redémarrage du conteneur interrompt le job en cours, qu'il faudra reprendre.

### Mises à jour suivantes : bouton « Mettre à jour Forge »

Une fois, sur l'hôte :

```bash
bash infra/08-forge-updater.sh --from /root/crystal_forge
```

Le script :

- installe dans le CT 150 le service `forge-update`, une unité systemd **hors du conteneur** : Forge n'a ni le socket Docker ni accès à l'hôte ;
- crée `/opt/forge/updates` ;
- passe la limite mémoire du CT 150 à 2 Go ;
- avec `--from`, déploie la copie locale par le même mécanisme.

Ensuite, **Réglages → Mise à jour** :

1. **Vérifier** compare la version installée au dernier commit de `BastienGRNT/crystal_forge@main` (réglages `forge.updateRepo` et `forge.updateBranch`).
2. **Mettre à jour** télécharge l'archive avec le jeton GitHub et la dépose dans `/opt/forge/updates`.
3. Le service vérifie l'archive, met de côté l'arborescence (`/opt/forge.previous`) et l'image (`forge:previous`), reconstruit, redémarre, puis attend que Forge réponde.
4. En cas d'échec, la version précédente est remise en place automatiquement.

`.env` et le volume `forge-data` ne sont jamais touchés. La mise à jour est refusée pendant un job, et les nouveaux jobs sont refusés pendant la mise à jour. Le journal s'affiche dans la page ; il est aussi dans `/opt/forge/updates/update.log` sur le CT.

## 6. Passer en écriture réelle

`DRY_RUN=true` par défaut : chaque écriture (Proxmox, GitHub, OVH, NPM, SSH) est journalisée `[DRY-RUN]` sans être exécutée. Les lectures restent actives.

1. Réglages → Tester les connexions : tout vert, matrice « La production est hors de portée de Forge ».
2. Un déploiement de test en DRY-RUN : lisez le journal étape par étape.
3. `DRY_RUN=false` dans `.env`, puis `docker compose up -d`.
4. Premier vrai déploiement sur un dépôt jetable et un sous-domaine de test.

## 7. Variables, migrations et bases de données

- **`.env.example`** : l'assistant lit `.env.example`, `.env.sample` ou `.env.template` (dans le sous-dossier choisi, sinon à la racine). Il pré-remplit le .env :
  - les secrets (`*_SECRET`, `*_PASSWORD`, `*_KEY`…) reçoivent une valeur aléatoire, qui remplace aussi leur valeur d'exemple dans `DATABASE_URL` ;
  - `ORIGIN` et `PUBLIC_URL` prennent le domaine, `PORT` le port.

  Les variables `${VAR}` du compose sans valeur par défaut sont signalées. L'onglet Variables compare ensuite votre .env au modèle de la branche, pour repérer les variables ajoutées par une mise à jour de l'app.
- **Migrations** : la bonne pratique est un service compose ponctuel attendu par l'app (`depends_on: migrate: condition: service_completed_successfully`). Les migrations passent alors avant le démarrage de la nouvelle version, et le déploiement s'arrête si elles échouent. L'assistant le détecte et propose l'extrait à ajouter. La « commande post-déploiement » reste disponible en option avancée.
- **Base de données** (PostgreSQL, MySQL, MariaDB) : si le compose en contient une, le workflow la sauvegarde **avant chaque déploiement**. Le dump va dans `/home/github/forge-backups/<projet>/`, et les 10 derniers sont gardés. L'onglet « Base de données » propose :
  - les tables et leurs données ;
  - une console SQL, en lecture seule par défaut. En mode écriture, les requêtes passent par le garde ; DROP, TRUNCATE, DELETE ou UPDATE sans WHERE demandent une confirmation et déclenchent une sauvegarde juste avant ;
  - les dumps (manuel, téléchargement) et la restauration, avec double confirmation et sauvegarde de l'état actuel d'abord ;
  - la commande de tunnel SSH pour DataGrip ou pgAdmin. Aucun port n'est exposé : les clients SQL tournent dans le conteneur de la base, avec ses propres identifiants.

## 8. Faire évoluer un projet

- **Taille** (onglet Conteneur) : préréglage S/M/L ou valeurs libres.
  - RAM et cœurs changent à chaud, dans les deux sens.
  - Le disque ne peut qu'être agrandi, à chaud aussi.
  - La RAM disponible sur l'hôte est vérifiée avant.
  - Une alerte s'affiche (Conteneur et Santé du serveur) au-delà de 80 % de disque utilisé.
- **Mettre à niveau le projet** (onglet Paramètres) : quand Forge évolue, cet écran compare ce qu'il produirait aujourd'hui avec ce qui est en place. Il couvre le workflow, les variables `FORGE_*`, le pare-feu, la taille et les mises à jour de sécurité, et applique les éléments cochés.
  - Le workflow n'est mis à jour **que s'il n'a pas été modifié à la main** depuis le dernier commit de Forge (empreinte enregistrée). Sinon, Forge montre le diff et la nouvelle version à reporter vous-même.
  - Le diff est montré avant le commit, et le commit est marqué `[skip ci]` : il ne déclenche pas de déploiement.
- **Mises à jour de sécurité** : le template installe `unattended-upgrades`, limité aux dépôts de sécurité d'Ubuntu (Docker exclu, pour éviter un redémarrage surprise des conteneurs). Pour les CT existants : « Mettre à niveau ».

## 9. Migrer une app existante (CT de prod) vers Forge

Forge ne touche jamais aux CT de prod. On recrée donc l'app, puis on y copie les données :

1. Créez le projet dans Forge depuis le même dépôt, sur un sous-domaine de test.
2. Sur l'hôte : `bash infra/06-migrate-db.sh 402 503` (CT source, puis CT Forge). Le script fait le dump dans le CT source, en lecture seule, et le copie dans les sauvegardes du projet. Il affiche aussi les volumes Docker du CT source, à copier avec `rsync` si l'app stocke des fichiers.
   - Variante sans script, pour un dump de moins de 100 Mo : onglet Base de données → **Importer un dump**.
3. Onglet Base de données → Sauvegardes → **Restaurer** la ligne « Importée ». La restauration demande une double confirmation et sauvegarde l'état actuel d'abord.
4. Vérifiez l'app sur le domaine de test, ajoutez le vrai domaine, puis arrêtez l'ancien CT.

## 10. Mode démo (sur votre PC)

```bash
pnpm install
pnpm dev:mock
```

Ouvrez `http://localhost:5173`. Toute l'infrastructure est simulée en mémoire (CT 100-404, zones OVH, proxy hosts NPM, dépôts GitHub) : déploiements, reprises, rollbacks, suppressions… sans jamais contacter une vraie API. La démo repart de zéro à chaque redémarrage ; le compte admin et les réglages sont conservés.

## Dépannage

Chaque cas : symptôme → cause → commande (sur l'hôte Proxmox sauf mention contraire).

### « Proxmox injoignable » (Tester les connexions, Santé du serveur)

- **Cause** : le pare-feu du datacenter est actif avec `policy_in=DROP`. L'hôte n'accepte 8006 que depuis `local_network`, pas depuis le CT 150 (10.10.10.15).
- **Correctif** : `bash infra/04-forge-ct.sh` ajoute la règle du nœud, ou directement :

  ```bash
  pvesh create /nodes/ns3125740/firewall/rules --type in --action ACCEPT --source 10.10.10.15 --proto tcp --dport 8006 --enable 1 --comment "Forge (CT 150) -> API Proxmox"
  ```

- Si l'erreur mentionne `UNABLE_TO_VERIFY_LEAF_SIGNATURE` : le CA collé n'est pas le bon. Collez `/etc/pve/pve-root-ca.pem`, ou videz le champ.

### « Template 900 hors du pool »

- **Cause** : le jeton n'a pas `Pool.Audit` sur `/pool/forge`. L'ACL `PVEVMAdmin` remplace le `PVEAuditor` hérité, et Proxmox masque alors le champ `pool`.
- **Correctif** :

  ```bash
  pveum acl modify /pool/forge --roles PVEPoolUser --users forge@pve --tokens 'forge@pve!forge' --propagate 1
  ```

- Si le template est réellement hors du pool (`pvesh get /pools/forge` ne le liste pas) : relancez `infra/03-template-docker-runner.sh`.

### Refus « Configurer le CT 5xx : n'est pas dans le pool »

- **Cause** : même cause que ci-dessus, c'est le garde qui refuse car le champ `pool` est vide.
- **Correctif** : la même commande `pveum acl modify … PVEPoolUser …`, puis **Reprendre** le job.

### Runner bloqué sur « Authentication » (config.sh)

- **Cause** : le CT a le pare-feu (`firewall=1`) et sort par un pont `fwbr`. Sans zone conntrack, le MASQUERADE ne s'applique plus et le CT n'a pas Internet.
- **Vérification**, dans le CT : `curl -sI https://api.github.com | head -n1`.
- **Correctif** : `bash infra/07-conntrack-zone.sh`, puis **Reprendre** le job.

### « Resource not accessible by personal access token »

- **Cause** : le jeton fine-grained n'a pas **Administration : Read and write**, ou le dépôt n'est pas dans son *Repository access*.
- **Correctif** : GitHub → Settings → Developer settings → Fine-grained tokens → le jeton → permissions et dépôts. Le jeton ne change pas, inutile de le recoller. Puis **Reprendre** le job.

### « CT is protected » / « protection mode enabled » (rollback, suppression)

- **Cause** : le clone a hérité de `protection=1` du template 900, pour les projets créés avant le correctif.
- **Correctif** : Forge retire désormais la protection lui-même avant de supprimer. À la main, **uniquement sur un CT de projet 500-599** : `pct set 503 --protection 0`.

### « Aucun domaine ne répond en HTTPS » alors que l'app fonctionne

- **Cause** : depuis le bridge `nat`, l'IP publique ne boucle pas vers NPM (pas de NAT en épingle). Le test joignait `51.68.180.212` et échouait.
- **Correctif** : Forge interroge désormais NPM (`10.10.10.2`) directement, avec le vrai nom de domaine (certificat et Host vérifiés). Mettez Forge à jour, puis **Reprendre** le job.

### « compose file "/home/github/…" is invalid » (onglet Base de données)

- **Cause** : la commande lancée par SSH exécutait `docker compose` depuis `/home/github` au lieu du dossier du dépôt.
- **Correctif** : corrigé dans Forge ; mettez Forge à jour.

### La mise à jour de Forge échoue

Consultez le journal (Réglages → Mise à jour, ou `pct exec 150 -- cat /opt/forge/updates/update.log`). Causes fréquentes :

- **« Mémoire du CT insuffisante »** : `pct set 150 --memory 2048`.
- **« Service de mise à jour absent »** : `bash infra/08-forge-updater.sh`.
- **Demande « jamais prise en charge »** : `pct exec 150 -- systemctl status forge-update.path`.
