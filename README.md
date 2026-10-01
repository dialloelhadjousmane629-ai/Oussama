# Carnet de dettes

Oussama diallo

Une fiche pour enregistrer les dettes, séparées en trois catégories, chacune avec son propre bouton d'affichage :

- **Transfert d'argent** : l'argent qu'on me doit sur les transferts
- **Boutique** : les marchandises prises à crédit par les clients
- **Mes dettes personnelles** : l'argent que je dois moi-même

Chaque dette est en **francs guinéens (GNF)** ou en **dollars (USD)**. Les totaux sont calculés séparément pour chaque devise, sans conversion.

## Fonctions

- Ajouter, modifier ou supprimer une dette (nom, téléphone, montant, devise, date, échéance, note)
- Enregistrer des paiements partiels. Le reste à payer et le statut se mettent à jour tout seuls : Non payé, Partiel, En retard (échéance dépassée), Soldé
- Bilan général : « On me doit » (transfert + boutique) et « Je dois » (dettes personnelles)
- Recherche par nom, numéro ou note ; filtres par statut et par devise
- Les montants s'écrivent librement : `2 500 000`, `2.500.000` ou `150,50`

## Utilisation

Ouvrez `public/index.html` dans un navigateur (téléphone ou ordinateur). Aucune installation n'est nécessaire.

Le site est aussi publié sur Cloudflare Workers : seul le dossier `public/` est mis en ligne (configuration dans `wrangler.jsonc`).

Les données sont enregistrées dans le navigateur de l'appareil (`localStorage`). Si vous effacez les données du navigateur, les dettes sont perdues.

## Raccourci sur le bureau ou l'écran d'accueil

Le site s'installe comme une application, avec sa propre icône, et s'ouvre même sans connexion.

- **Ordinateur (Chrome ou Edge)** : ouvrez https://oussama.dialloelhadjousmane629.workers.dev puis cliquez sur « Installer sur cet appareil » en haut de la page (ou sur l'icône d'installation dans la barre d'adresse). Le raccourci apparaît sur le bureau et dans le menu Démarrer.
- **Android (Chrome)** : menu ⋮ puis « Ajouter à l'écran d'accueil » ou « Installer l'application ».
- **iPhone (Safari)** : bouton Partager puis « Sur l'écran d'accueil ».

## Assistant IA

La page `/ia.html` (bouton « Assistant IA » dans le carnet) est un assistant basé sur Claude. Il répond en français, cherche sur internet, lit des pages web, calcule et rédige (textes, code, plans, tableaux). Il peut aussi lire le carnet de dettes si la case « Partager mon carnet » est cochée.

Il n'a accès qu'à la recherche web et à la lecture de pages : il n'envoie pas de messages et ne modifie rien tout seul.

Configuration sur Cloudflare (Workers → oussama → Settings → Variables and Secrets), deux secrets :

- `ANTHROPIC_API_KEY` : votre clé de l'API Anthropic (console.anthropic.com)
- `MOT_DE_PASSE` : le mot de passe demandé sur la page pour éviter que d'autres utilisent votre clé

En local : `npm install`, un fichier `.dev.vars` avec ces deux lignes, puis `npx wrangler dev`.

## LA FAMILLE BEST — Gestion de caisse

Logiciel permanent de gestion financière de la communauté (page `/caisse/`). Franc guinéen (GNF), cotisation de 10 000 GNF par membre et par mois, depuis le 1er octobre 2026, sans date de fin.

**Architecture**

- `public/caisse/index.html` : interface (bleu nuit / blanc / doré, responsive téléphone-tablette-ordinateur)
- `src/caisse.js` : API (`/api/c/*`) sur Cloudflare Workers, base **D1** (SQLite) persistante. Les tables sont créées automatiquement au premier appel.
- Tables : `users`, `members`, `operations` (cotisations, recettes, dépenses), `audit`, `closings` (archives annuelles), `counters`, `settings`, `backups`

**Fonctions**

- Années : 2026 (oct.–déc.) puis 12 mois par année, sans limite. Tableau de bord, statistiques et rapports propres à chaque année ; « Historique des années » conserve tout.
- Clôture annuelle automatique : l'exercice terminé est figé (immuable). Son solde de clôture est reporté comme solde d'ouverture, sans être recompté en recette.
- Membres (numéro unique FB-0001…, désactivation sans perte d'historique), cotisations (PAYÉ / NON PAYÉ / PARTIEL / EN AVANCE), dépenses, recettes, dettes
- Journal de caisse : référence unique, date et heure, auteur, solde après opération. Rien n'est effacé : une opération se corrige par une **annulation motivée** (reste visible, barrée) et tout est tracé dans l'historique d'audit.
- Rapports : mensuel, trimestriel, annuel, individuel, membres à jour / en retard, dépenses, journal, bilan général ; export PDF (impression) et Excel
- Consultation publique : toute personne ayant le lien voit les comptes en lecture seule, sans connexion et sans numéros de téléphone ; seuls les comptes connectés (Administrateur, Trésorier) peuvent écrire. Profils : Administrateur, Trésorier, Consultation (compte nommé en lecture seule). Mots de passe hachés (PBKDF2), session signée de 12 h, déconnexion après 15 min d'inactivité, verrouillage après 5 échecs.
- Sauvegarde : instantané interne hebdomadaire automatique (cron), téléchargement / restauration JSON (un instantané de sécurité est pris avant toute restauration), plus l'historique Time Travel de D1 (30 jours)

**Mise en service** : `npm install`, puis `npx wrangler deploy` (la base D1 est créée automatiquement). Au premier accès à `/caisse/`, créez le compte administrateur. En local : `npx wrangler dev`.
