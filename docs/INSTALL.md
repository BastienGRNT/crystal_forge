# Installer Forge

**En une commande** : `bash infra/bootstrap.sh` enchaîne les scripts ci-dessous dans l'ordre et saute ce qui est déjà fait. Un premier passage installe 01, 02 et 04. Relancez-le ensuite avec la clé publique de Forge : `bash infra/bootstrap.sh "ssh-ed25519 AAAA… forge"` installe 03 et 05.

Ordre détaillé (chaque étape est réversible, aucune ne touche aux CT existants) :

1. `infra/01-backup-job.sh` : sauvegardes quotidiennes de la prod (à faire en premier).
2. `infra/02-proxmox-forge-access.sh` : pool `forge`, utilisateur `forge@pve`, jeton API.
3. `infra/04-forge-ct.sh` : CT 150 qui hébergera Forge.
4. Déployer Forge sur le CT 150 (section 5), créer le compte admin, **générer la clé SSH** dans Réglages.
5. `infra/03-template-docker-runner.sh "<clé publique>"` : template 900.
6. Créer le jeton GitHub, les clés OVH et le compte NPM (sections 2 à 4), les saisir dans Réglages.
7. `infra/05-firewall.sh` : active le pare-feu Proxmox du datacenter, sans filtrer l'hôte, pour que l'isolement par CT s'applique.
8. **Réglages → Tester les connexions** : tout doit être vert, et la matrice doit montrer que les CT de prod sont en lecture seule. Ensuite, **Santé du serveur** doit être au vert.
9. Faire un premier déploiement **en DRY-RUN** (par défaut), lire le journal, puis passer `DRY_RUN=false`.

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
| `/storage/local` | PVEDatastoreUser | allouer les disques des clones, vzdump |
| `/sdn/zones/localnetwork/nat` | PVESDNUser | utiliser le bridge `nat` uniquement (pas `vmbr0`) |

Ces privilèges ont été vérifiés dans le source de `pve-container` (PVE 9) :

- `POST /lxc/{vmid}/clone` exige `VM.Clone` sur le template, `VM.Allocate` sur `/pool/forge` (avec le paramètre `pool`), `Datastore.AllocateSpace` et `SDN.Use` sur le bridge. La config, y compris `features: nesting`, est recopiée sans revérifier les droits root.
- `PUT /lxc/{vmid}/config` exige `VM.Config.*` selon les clés modifiées. `features` reste réservé à `root@pam`, c'est pourquoi Forge clone un template plutôt que de créer depuis l'ostemplate.

À la fin, le script vérifie que le jeton **n'a aucun droit d'écriture** sur 100, 101 et 401-404. Il affiche ensuite le secret du jeton (une seule fois) et le certificat CA de Proxmox, à coller dans Réglages → Proxmox.

### 1.3 CT de Forge — `04-forge-ct.sh`

```bash
bash infra/04-forge-ct.sh
```

Crée le CT 150 `forge` : 10.10.10.15, 1 cœur, 1 Go, 8 Go, Docker, **hors du pool forge** (Forge ne peut pas se supprimer lui-même).

Il installe aussi un pare-feu : le port 3000 n'est accepté que depuis `10.10.10.1` (l'hôte : avec Tailscale en routeur de sous-réseau, vos requêtes arrivent avec cette adresse source à cause du SNAT) et `100.64.0.0/10`. Les autres CT du bridge, dont les apps de prod, ne peuvent pas joindre Forge.

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

---

## 2. Jeton GitHub (fine-grained)

GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate new token* :

- **Resource owner** : `BastienGRNT`
- **Repository access** : *All repositories* (pour lister les dépôts dans l'assistant), ou *Only select repositories*
- **Expiration** : à votre convenance (Forge affiche la date d'expiration dans le test de connexion)
- **Repository permissions** :

| Permission | Accès | Utilisé pour |
|---|---|---|
| Administration | Read and write | jeton d'enregistrement / retrait du runner |
| Secrets | Read and write | secret `ENV_FILE` |
| Variables | Read and write | variables `FORGE_*` |
| Actions | Read and write | lancer et suivre les runs |
| Contents | Read and write | commit de `forge-deploy.yml` |
| Workflows | Read and write | obligatoire pour écrire dans `.github/workflows` |
| Metadata | Read-only | obligatoire |

Collez le jeton (`github_pat_…`) dans Réglages → GitHub.

## 3. Clés OVH

Ouvrez le lien **createToken** proposé dans Réglages → OVH : il est généré pour vos zones. Pour `bastiengrnt.fr` et `pharmagaia.com`, il ressemble à :

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

Mise à jour de Forge : relancez le `rsync` depuis votre PC, puis sur le CT :

```bash
cd /opt/forge && docker compose up -d --build
```

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
