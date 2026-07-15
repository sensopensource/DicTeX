# Principes de conception des conventions

Ce document explique pourquoi les conventions orales de DicTeX prennent leur
forme. Le registre `docs/questions-de-conventions.md` conserve les questions et
leur statut ; `docs/product-decisions.md` fixe les décisions durables. Une
convention décidée n'est pas nécessairement déjà implémentée dans le moteur.

## Principe fondamental

```text
une formulation orale canonique
-> une seule structure explicite
-> une seule couche 2 déductible du segment courant
```

La couche 2 ne complète jamais une information grâce au thème du cours, au
segment précédent ou à une interprétation mathématique plausible. Si une
dimension, une portée, une unité, un opérande, une casse ou un séparateur compte
dans la cible, cette information doit être prononcée.

## Règles de conception

1. **Suffisance locale.** Toute la cible doit être déductible de la couche 1 du
   segment courant.
2. **Structure explicite.** Les délimiteurs, séparateurs et changements de casse
   sont dictés au lieu d'être reconstruits par le contexte.
3. **Sortie unique.** Une formulation canonique ne doit pas admettre plusieurs
   couches 2. En cas d'ambiguïté, on change la formulation orale ; on ne demande
   pas au moteur de deviner.
4. **Prose préservée.** Un mot courant reste de la prose hors d'un motif borné.
   Par exemple, la convention `grand f` ne transforme pas « un grand nombre ».
5. **Déterminisme d'abord.** Le dictionnaire traite les variantes lexicales, les
   commandes portent les actions explicites et les regex couvrent les motifs
   bornés. Un futur modèle apprend le résidu de composition ; il ne répare pas
   une information qui n'a jamais été prononcée.
6. **Contrat distinct de l'implémentation.** Le registre peut décider une forme
   cible avant son ajout au normaliseur. Les exemples de collecte doivent donc
   vérifier séparément la convention et la prise en charge réelle du moteur.

## Exemples directeurs

| Couche 1 | Couche 2 | Pourquoi |
| --- | --- | --- |
| `grand f` | `$F$` | la casse est prononcée |
| `petit f` | `$f$` | la minuscule peut être rendue explicite |
| `parenthèse ouvrante x séparateur y séparateur z parenthèse fermante` | `$(x,y,z)$` | l'arité et les délimiteurs sont explicites |
| `zéro virgule zéro` | `$0{,}0$` | `virgule` appartient au nombre décimal |
| `parenthèse ouvrante zéro séparateur zéro parenthèse fermante` | `$(0,0)$` | `séparateur` ne peut pas être confondu avec la virgule décimale |

« Vecteur nul » ne peut jamais produire automatiquement `(0,0)` ou `(0,0,0)` :
la dimension et les coordonnées ne sont pas prononcées. La formulation reste en
prose ou reçoit plus tard une notation générique explicitement décidée.

## Passe obligatoire pour créer une paire Layer 1 / Layer 2

1. Écrire d'abord la couche 2 utile au cours ou à l'exercice.
2. La verbaliser à rebours avec les seules conventions décidées.
3. Vérifier, fragment par fragment, que chaque symbole et chaque structure de la
   couche 2 possède une source orale non ambiguë.
4. Si une convention manque, ouvrir une question dans le registre au lieu
   d'improviser une formulation.
5. Après la dictée, corriger la couche 1 contre ce qui a réellement été prononcé,
   pas contre le script prévu.
6. Ne conserver la paire `math_transform` que si la couche 2 reste entièrement
   déductible de cette couche 1 corrigée.

Cette passe s'applique aussi aux cours synthétiques destinés à amorcer la
collecte : leur intérêt pédagogique n'autorise aucune inférence cachée dans la
cible d'entraînement.
