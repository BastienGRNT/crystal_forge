# Forge

Mini-PaaS personnel pour Proxmox : **1 projet = 1 conteneur LXC = 1 runner GitHub self-hosted**, avec Nginx Proxy Manager devant et les DNS chez OVH.

Un dépôt GitHub (docker-compose ou Dockerfile) devient en quelques clics :
un CT cloné depuis le template 900 → un runner enregistré → le secret `ENV_FILE` et les variables `FORGE_*` → le workflow `forge-deploy.yml` (après votre confirmation) → un enregistrement A chez OVH → un proxy host NPM avec Let's Encrypt → un premier run suivi jusqu'au check HTTPS.

Et aussi :

- le .env pré-rempli depuis le `.env.example` du dépôt ;
- la détection des migrations gérées par compose ;
- un onglet **Base de données** : tables, console SQL en lecture seule par défaut, dumps avant chaque déploiement, restauration ;
- un **pare-feu Proxmox par CT**, qui isole chaque projet de la prod ;
- une page **Santé du serveur** : contrôles en lecture seule avec la commande à lancer pour chaque problème ;
- `infra/bootstrap.sh` pour tout installer en une commande.

## Démarrer

```bash
pnpm install
pnpm dev:mock      # démo : infrastructure simulée, rien de réel n'est contacté
pnpm test          # tests unitaires (vitest)
pnpm check         # svelte-check / TypeScript strict
```

Installation sur le serveur : voir [docs/INSTALL.md](docs/INSTALL.md).

## Sécurité, en bref

- **Permissions Proxmox** : le jeton `forge@pve` n'a les droits d'écriture que sur le pool `forge`. Les CT de prod sont hors de portée, même en cas de bug. « Tester les connexions » le prouve CT par CT.
- **Garde d'écriture unique** (`src/lib/server/application/guard.ts`) : chaque écriture passe par une règle de sécurité puis, en `DRY_RUN`, est seulement journalisée.
- **Ajout seulement** sur NPM, OVH et GitHub : Forge enregistre ce qu'il crée (table `resources`) et refuse de modifier ou supprimer le reste. Pas d'AAAA, aucune commande qui supprime des volumes.
- **Secrets** chiffrés en AES-256-GCM (`FORGE_MASTER_KEY`), masqués dans les logs. Le `.env` n'est affiché qu'après re-saisie du mot de passe.
- **Isolement réseau** : pare-feu Proxmox sur chaque CT de projet (entrée réservée à NPM, Forge et l'hôte ; sortie vers le bridge bloquée).
- **Bases de données** : console en lecture seule par défaut ; écritures via le garde ; sauvegarde automatique avant toute opération destructrice. Aucun port de base exposé.
- **Accès** via Tailscale uniquement (pare-feu du CT 150 + liste d'adresses dans l'app), avec un login admin argon2id.

## Architecture

```
src/lib/domain/                 règles pures et testées (allocation IP/CTID, .env, workflow, politique de sécurité)
src/lib/server/application/     ports, passerelles (garde + règles), moteur de jobs, cas d'usage
src/lib/server/infrastructure/  clients Proxmox / GitHub / OVH / NPM / SSH, SQLite (Drizzle), crypto, mode mock
src/lib/components/             atomic design : atoms (shadcn-svelte) → molecules → organisms → templates
src/routes/                     pages SvelteKit (+ SSE des jobs dans /api/jobs/[id]/events)
infra/                          scripts à lancer soi-même sur l'hôte Proxmox
```
