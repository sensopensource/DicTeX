# Périmètre du MVP

Le MVP doit prouver que DicTeX peut servir chaque jour comme couche de dictée
scientifique sans perdre la pensée ni les données nécessaires à son
amélioration.

## Utilisateur cible

L'utilisateur initial est le créateur du projet, en français, sur sa machine et
avec son micro. L'élargissement à d'autres utilisateurs vient après la
stabilisation de ce flux personnel.

## Déjà dans le MVP

- enregistrement de segments courts ;
- transcription locale faster-whisper ;
- choix du modèle STT ;
- raccourci global et collage sous Windows ;
- conservation locale de chaque audio et texte brut ;
- normaliseur déterministe : dictionnaire, commandes et regex ;
- sortie LaTeX canonique en ligne ;
- historique de copie et de réécoute ;
- Lab séparé pour les corrections typées, les mesures et les exports.

## À terminer avant l'usage quotidien

- choisir et valider Typora comme cahier externe ;
- unifier Start/Stop entre le bouton et le raccourci ;
- produire explicitement des mathématiques en ligne ou en bloc ;
- garder le modèle STT en mémoire entre les dictées ;
- comparer puis choisir un contexte initial STT ;
- valider une correction complète jusqu'à l'export du Lab.

## Portée mathématique initiale

Les règles déterministes restent volontairement étroites :

- variables et nombres simples ;
- opérations arithmétiques ;
- puissances et racines simples ;
- fractions à opérandes non ambiguës ;
- relations et équations simples.

Les intégrales, sommes, matrices et expressions imbriquées doivent déjà pouvoir
être représentées dans le contrat LaTeX et saisies/corrigées dans le cahier,
mais leur compréhension vocale composée appartient au résidu à mesurer. Une
regex ne doit pas inventer une portée qu'elle ne connaît pas.

## Hors périmètre

- propriété ou gestion des documents ;
- éditeur interne complet ;
- démonstration ou vérification symbolique générale ;
- synchronisation en nuage et collaboration ;
- application mobile ;
- entraînement d'un modèle avant une référence et des données propres ;
- infrastructure générique de modèles ou d'expériences.

La [feuille de route](roadmap.md) fixe les critères permettant de quitter ce
périmètre.
