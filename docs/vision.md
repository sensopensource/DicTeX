# Vision

DicTeX doit devenir un système personnel de brouillon scientifique : parler
librement, obtenir un mélange lisible de prose et de mathématiques, corriger
rapidement, puis réutiliser chaque correction pour améliorer le système local.

```text
voix + micro
-> STT local adapté à l'utilisateur
-> texte littéral conservé
-> normalisation déterministe
-> petit modèle résiduel texte-vers-LaTeX
-> brouillon Markdown + LaTeX
-> correction rapide
-> amélioration continue locale
```

La [feuille de route](roadmap.md) traduit cette vision en étapes et en portes de
sortie mesurables.

## Problème

Les outils STT généralistes ne suffisent pas au raisonnement mathématique. Ils
doivent composer avec la prose, les équations, les ambiguïtés de portée, les
hésitations et les corrections sans interrompre la pensée.

Les erreurs ne forment pas un seul problème :

- une erreur **acoustique** signifie que le STT a mal entendu ;
- une erreur de **transformation mathématique** signifie que le texte entendu
  correctement n'a pas été converti dans la bonne notation ;
- une erreur de **flux** signifie que l'enregistrement, l'insertion ou la
  correction a coûté trop de temps ou perdu une donnée.

DicTeX conserve ces couches séparées afin d'appliquer le bon remède à chacune.

## Forme du produit

DicTeX n'est pas un éditeur de documents. Il agit comme une couche locale de
dictée et insère son résultat dans un cahier externe. Typora est le premier
environnement réel retenu ; les fichiers restent du Markdown portable avec du
LaTeX, donc le cahier pourra changer sans invalider les données.

DicTeX Lab est l'atelier séparé : réécoute, corrections typées, ensembles de
validation, mesures et exports. La complexité expérimentale ne doit pas envahir
l'outil quotidien.

## Principes

- local et personnel par défaut ;
- français parlé en premier ;
- documentation et coordination du projet en français ;
- texte brut, audio et intermédiaires jamais sacrifiés ;
- correction aussi importante que l'exactitude initiale ;
- Markdown pour la prose, LaTeX canonique pour les mathématiques ;
- session et segment avant document ;
- règles déterministes avant apprentissage ;
- entraînement seulement sur une cible stable et un gain mesurable ;
- pas d'éditeur complet tant que le cahier externe ne bloque pas le flux réel.
