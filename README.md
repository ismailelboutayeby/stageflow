# StageFlow

Plateforme de gestion des demandes de stage — Next.js 15, React 19, TypeScript
strict, Supabase (PostgreSQL + RLS + stockage privé).

Application en français, à deux rôles : **Stagiaire** et **Administrateur**.

---

## Quick start (current working setup)

The app on this machine is configured to run on `http://localhost:3000`
against the **hosted Supabase project** (`.env.local` already holds the real
URL, publishable key and service-role key).

```bash
npm install
npm run services:check     # probes Auth, DB, service key, private bucket
npm run dev                # http://localhost:3000
```

Open `/etat-installation` for an in-app diagnostic of every prerequisite.

> **Supabase free-tier projects pause after 7 days of inactivity.** A paused
> project loses its `*.supabase.co` DNS record, so signup/login fail with a
> network error even though the code is fine. Restore the project in the
> Supabase dashboard, then re-run `npm run services:check`.

Other modes:

| Goal | How |
| --- | --- |
| Fully offline stack (Postgres + Auth + Storage + local Inbox) | `cp .env.local.localstack-backup .env.local` then `npx supabase start` — **requires Docker Desktop**; mail is captured at `http://127.0.0.1:54324` |
| Provision everything with the CLIs | `cp .env.cli.example .env.cli`, add tokens, `npm run cli:setup` — see [docs/CLI_WORKFLOW.md](docs/CLI_WORKFLOW.md) |
| Deploy to Vercel | [docs/VERCEL_DEPLOY.md](docs/VERCEL_DEPLOY.md) |
| Verify signup/login with a throwaway account | `npm run services:check -- --with-auth` |
| Send one real confirmation e-mail | `npm run services:check -- --smtp-test you@mail.com` |

---

## Démarrage rapide

```bash
npm install
cp .env.example .env.local     # puis renseigner les valeurs Supabase
npm run dev                     # http://localhost:3000
```

Avant de pouvoir se connecter, il faut appliquer les migrations et créer un
administrateur — voir **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

Pour diagnostiquer une installation incomplète, ouvrez **`/etat-installation`** :
cette page sonde réellement chaque prérequis et indique la correction exacte.

---

## Lancer le projet dans VS Code

Le dossier `.vscode/` est fourni : aucune configuration manuelle n'est nécessaire.

### La méthode la plus rapide

1. Ouvrir le dossier du projet dans VS Code (`Fichier → Ouvrir le dossier`).
2. Appuyer sur **`F5`**.
3. Le serveur démarre et Chrome s'ouvre sur `http://localhost:3000`.

### Trois configurations sont disponibles (`F5` → liste déroulante)

| Configuration | Usage |
| --- | --- |
| **StageFlow: Dev Server** | Démarre simplement le serveur. C'est celle à utiliser au quotidien. |
| **StageFlow: Debug Full Stack** | Démarre le serveur *avec* le débogueur : points d'arrêt dans les Server Components **et** dans le navigateur. |
| **StageFlow: Attach Chrome** | À utiliser si le serveur tourne déjà dans un terminal. |

> **Points d'arrêt** — sans la configuration *Debug Full Stack*, un point d'arrêt
> placé dans un Server Component (par exemple `app/(public)/page.tsx`) ne sera
> jamais atteint : le code serveur s'exécute dans un autre processus Node.

### Sans `F5`, depuis le terminal intégré

`Ctrl + ù` (ou `Terminal → Nouveau terminal`), puis :

```bash
npm run dev
```

Puis `Ctrl + clic` sur l'adresse `http://localhost:3000` affichée.

### Tâches VS Code (`Ctrl + Shift + B`, ou `Terminal → Exécuter la tâche`)

`dev` (par défaut) · `build` · `typecheck` · `lint` · `test` · `test:watch`

### Extensions recommandées

VS Code les proposera à l'ouverture du dossier : ESLint, Prettier, Tailwind CSS
IntelliSense. Elles ne sont pas obligatoires — le projet compile sans elles — mais
sans l'extension Tailwind, les classes `sf-btn-primary`, `text-ink-muted`, etc.
n'auront ni autocomplétion ni aperçu de couleur.

### Si le serveur s'arrête juste après « Starting… »

Cela se produit lorsque le fichier `package-lock.json` est désynchronisé des
binaires natifs SWC. Next.js tente alors de le réparer via `npm config get
registry`, ce qui échoue et tue le processus. Les configurations fournies
désactivent déjà cette réparation (`NEXT_IGNORE_INCORRECT_LOCKFILE=1`). Si le
problème réapparaît dans un terminal manuel :

```bash
NEXT_IGNORE_INCORRECT_LOCKFILE=1 npm run dev
```

Sous PowerShell :

```powershell
$env:NEXT_IGNORE_INCORRECT_LOCKFILE="1"; npm run dev
```

---

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement |
| `npm run build` | Construction de production |
| `npm start` | Serveur de production |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, sans émission |
| `npm test` | Tests unitaires (Vitest) |
| `npm run test:watch` | Tests en mode surveillance |
| `npm run test:e2e` | Tests de bout en bout (Playwright) |
| `npm run format` | Prettier |

---

## Les 11 écrans

| # | Écran | Route |
| --- | --- | --- |
| 01 | Accueil | `/` |
| 02 | Inscription | `/inscription` |
| 03 | Connexion | `/connexion` |
| 04 | Tableau de bord stagiaire | `/stagiaire/tableau-de-bord` |
| 05 | Profil stagiaire | `/stagiaire/profil` |
| 06 | Formulaire de demande | `/stagiaire/demande` |
| 07 | Documents et soumission | `/stagiaire/documents` |
| 08 | Suivi de la demande | `/stagiaire/suivi` |
| 09 | Tableau de bord admin | `/admin/tableau-de-bord` |
| 10 | Gestion des demandes | `/admin/demandes` |
| 11 | Détails et décision | `/admin/demandes/[id]` |

La correspondance exacte entre chaque image de référence et son fichier
d'implémentation figure dans
**[docs/DESIGN_REFERENCE_MAP.md](docs/DESIGN_REFERENCE_MAP.md)**.

---

## Les cinq états d'une demande

```
DRAFT ──► SUBMITTED ──► UNDER_REVIEW ──┬──► ACCEPTED
Brouillon   Envoyée      En examen      │    Acceptée
                                        └──► REJECTED
                                             Refusée
```

**Cinq états, pas six.** Le libellé « En attente » visible sur les maquettes est
une présentation de `SUBMITTED` (utilisée dans les tuiles d'indicateurs), jamais
un état distinct.

**Acceptée et Refusée ne sont pas des étapes successives** mais deux issues
terminales alternatives. La chronologie affiche donc un quatrième nœud unique,
qui affiche « Décision » tant que le dossier est actif, puis le verdict réel.

---

## Principes d'architecture

**La sécurité est appliquée par la base de données.** Chaque table porte une
politique RLS. Contourner l'application — un appel REST direct avec le jeton d'un
utilisateur — se heurte aux mêmes règles.

**Le rôle ne provient jamais de la requête.** Il est lu dans `user_roles`, une
table dépourvue de toute politique d'écriture, protégée par un déclencheur, avec
les fonctions d'amorçage révoquées des rôles clients. Un jeton forgé contenant
`role: "admin"` n'a aucun effet.

**La clé de service ne quitte jamais le serveur.** Elle n'est utilisée que pour
deux opérations, après qu'une autorisation a déjà été vérifiée. Elle n'est jamais
utilisée pour lire des données au nom d'un utilisateur, ce qui contournerait la
RLS.

**Les fichiers sont inspectés sur leurs octets réels.** Un fichier nommé `cv.pdf`
mais contenant du HTML est refusé, car ses octets ne commencent pas par `%PDF`.

**Le stockage reste privé.** Aucune URL signée n'est exposée au navigateur : les
téléchargements passent par une route qui revalide l'autorisation à chaque
requête.

Détails complets : **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** et
**[docs/SECURITY.md](docs/SECURITY.md)**.

---

## État vérifié

Dernière vérification : **20 octobre 2026**, contre le projet Supabase de
développement `khrdcrpdiqmlcecbybfo` (migrations 0001–0005 appliquées).

| Vérification | Résultat |
| --- | --- |
| `npm test` | ✅ 159 réussis, 25 ignorés (suite RLS) |
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npx eslint .` | ✅ 0 problème |
| `npx next build` | ✅ 23 pages générées, 25 routes |
| **Base : 8 tables** | ✅ présentes |
| **RLS activée** | ✅ 8/8 tables |
| **Politiques RLS** | ✅ 20 (toutes `authenticated`, aucune `anon`) |
| **Déclencheurs** | ✅ 4, dont `on_auth_user_created` |
| **Fonctions** | ✅ 16, dont les 9 RPC applicatives |
| **Bucket privé** | ✅ `application-documents`, `public = false`, 5 Mio, PDF/PNG/JPEG |
| **Durcissement Phase 2** | ✅ `log_audit` non exécutable par `anon`/`authenticated`/`service_role` ; 9 RPC refusées à `anon` ; politique storage sur-large supprimée (5 → 4) |
| **Advisor Supabase** | ✅ 0 erreur · 23 avertissements (contre 33 avant durcissement) |
| Suite RLS automatisée | ⚠️ Écrite, **non exécutée** (exige la clé `service_role`) |
| Tests Playwright | ⚠️ Non exécutés (navigateurs non installés) |
| Historique de migration | ⚠️ Table `schema_migrations` absente — voir `docs/DEPLOYMENT.md` |

Les tests de sécurité au niveau de l'API ont été exécutés réellement : écriture
anonyme refusée sur les 8 tables, RPC protégées renvoyant `AUTH_REQUIRED` /
`FORBIDDEN`, `promote_to_admin` inaccessible (`permission denied`). Détail
complet dans `docs/TEST_REPORT.md`.

---

## Limites connues

Documentées parce qu'un système dont on ignore les limites ne peut pas être
exploité sereinement.

| Limite | Détail |
| --- | --- |
| Analyse antivirus | Absente. Types restreints, téléchargement en pièce jointe et CSP `sandbox` atténuent le risque sans l'éliminer. |
| Limitation de débit | En mémoire, par processus : en serverless, la limite effective est multipliée par le nombre d'instances. |
| CSP | `'unsafe-inline'` reste nécessaire aux scripts (streaming Next.js) ; un nonce lèverait la contrainte. |
| Suite RLS | Écrite mais jamais exécutée — aucune base de données accessible ici. À lancer avant de faire confiance aux garanties d'isolation. |
| Pages légales | Modèles marqués « version préliminaire ». **Aucune conformité n'est revendiquée.** |
| Responsive | Les maquettes ne couvrent que 1080×675 px. Les déclinaisons tablette et mobile relèvent de la conception, pas de la reproduction. |

---

## Documentation

| Document | Contenu |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Vue d'ensemble, cycle de vie, choix techniques |
| [SECURITY.md](docs/SECURITY.md) | Modèle de menace, défenses, et ce qui n'est pas couvert |
| [DATABASE.md](docs/DATABASE.md) | Schéma, contraintes, fonctions, politiques RLS |
| [DESIGN_REFERENCE_MAP.md](docs/DESIGN_REFERENCE_MAP.md) | Chaque maquette → son fichier, jetons extraits, écarts assumés |
| [TEST_REPORT.md](docs/TEST_REPORT.md) | Ce qui est prouvé, ce qui ne l'est pas, et pourquoi |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Installation, vérifications post-déploiement, exploitation |

---

## Structure du projet

```
app/
  (public)/         Écrans 01–03 + pages légales
  (stagiaire)/      Écrans 04–08 (protégés)
  (admin)/          Écrans 09–11 (protégés)
  api/              Déconnexion, téléchargement contrôlé
  auth/callback/    Échange PKCE / vérification OTP

components/
  ui/               Primitives sans logique métier
  public/           Formulaires publics
  stagiaire/        Composants de l'espace stagiaire
  admin/            Composants de l'espace administration

lib/
  auth/             Session, actions, limitation de débit
  permissions/      Machine à états, règles de routes
  validation/       Schémas Zod, inspection des fichiers
  db/               Accès aux données
  actions/          Server Actions

supabase/migrations/  Schéma, RLS, fonctions, amorçage
docs/                 Documentation
tests/                Tests unitaires et RLS
```

---

## Préserver les images de référence

Les trois dossiers de maquettes sont conservés **tels quels**. Aucune image n'a
été déplacée, renommée, recompressée ni supprimée.

À noter : `stageflow_admin_pages/` et `stageflow_public_pages/` ne contiennent
que des **doublons** de six des onze images de `stageflow_11_mockups`. Il existe
donc 11 écrans uniques, et non 17.
