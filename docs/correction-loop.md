# Boucle de correction

La correction visible se fait d'abord dans le cahier externe afin de préserver
le flux de pensée. La qualification et la conservation structurée des exemples
se font ensuite dans DicTeX Lab.

## Chemin actuel à valider

```text
dictée dans DicTeX
-> insertion dans Typora
-> correction immédiate du brouillon dans Typora
-> ouverture du segment correspondant dans le Lab
-> réécoute de l'audio
-> couche 1 : transcription littérale exacte
-> couche 2 : prose et LaTeX corrigés
-> choix de l'ensemble
-> enregistrement à ajout uniquement
-> export et contrôle
```

DicTeX ne lit pas automatiquement les modifications faites dans Typora. Pour le
premier usage, le transfert vers le Lab reste volontaire et manuel. Une capture
automatique des corrections externes ne sera envisagée que si ce chemin devient
le goulot d'étranglement observé.

## Deux corrections distinctes

Une correction acoustique produit la paire :

```text
audio -> transcription littérale exacte
```

Elle porte `correction_kind = "acoustic"` et conserve les hésitations réellement
prononcées.

Une correction mathématique produit la paire :

```text
texte littéral -> prose et notation LaTeX canoniques
```

Elle porte `correction_kind = "math_transform"`. Elle ne doit jamais prétendre
posséder un audio lorsqu'elle provient d'un texte collé.

Les corrections `normalization` et `rephrasing` restent distinctes et ne doivent
pas contaminer les deux jeux d'entraînement précédents.

## Règles de conservation

- Ne jamais modifier un ancien `stt_result`.
- Ajouter un événement `stt_correction` pour chaque nouvelle vérité humaine.
- Conserver `session_id`, `segment_id` et `audio_ref` afin de retrouver la
  source.
- Garder la dernière correction de chaque type, pas seulement la dernière
  correction globale du segment.
- Canonicaliser le LaTeX au moment de la mesure et de l'export, sans réécrire la
  cible humaine stockée.
- Ne jamais stocker un marqueur interne de commande dans une correction.

## Premier contrôle obligatoire

Avant toute collecte en volume, auditer manuellement un exemple complet : audio
présent, texte brut inchangé, couches 1 et 2 correctes, appartenance à
`validation`, export lisible et chemins audio valides. `test_frozen` ne sert pas
à ce contrôle courant.

Les détails de schéma et d'export sont définis dans
`dataset-and-normalization-design.md`.
