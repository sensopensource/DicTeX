# Questions de conventions ouvertes

Ce document recueille les questions découvertes pendant les dictées réelles.

Ce n'est pas une spécification : une question ouverte ne bloque ni la collecte
ni un benchmark. Lorsqu'une décision est prise, elle est déplacée vers
`docs/product-decisions.md` avec des exemples et une date.

## Notation et vocabulaire mathématique

- [ ] Pour `0^\circ`, quelle formulation orale privilégier : « zéro degré »
  ou « angle zéro » ? Quelle cible LaTeX canonique en découle ?
- [ ] Pour l'exponentielle, faut-il dire « e puissance x » ou
  « exponentielle de x » ? La couche 2 produit-elle `e^x` ou `\exp(x)` ?
- [ ] Pour le logarithme naturel, faut-il dire « logarithme de x », « ln de x »
  ou « logarithme népérien de x » ? Quelle différence orale réserver à `log` ?
- [ ] Comment annoncer la constante `e` sans la confondre avec une lettre ou
  un mot mal entendu ?
- [ ] Pour les décimaux, quelle forme orale retenir, par exemple
  « zéro virgule deux » et « vingt virgule zéro huit cinq » ? Comment séparer
  cette virgule décimale de la ponctuation de phrase ?
- [ ] Quelle orthographe canonique conserver dans la couche 1 pour les nombres
  composés, par exemple « quatre-vingts », « quatre-vingt-dix » et
  « cent quatre-vingts » ?
- [ ] Pour la trigonométrie, faut-il dire « sinus de x » ou
  « sinus de l'angle x » ? Comment annoncer explicitement degrés et radians ?
- [ ] Quelle différence orale retenir entre « inférieur à », « strictement
  inférieur à » et « inférieur ou égal à » ?
- [ ] Comment désambiguïser les chaînes comme « a inférieur à b inférieur à c » ?
- [ ] Quelle portée donner à « moins », « sur », « racine de », « puissance de »
  et « indice » ? Quand les parenthèses orales deviennent-elles obligatoires ?
- [ ] Quelles formes orales canoniques choisir pour les lettres grecques :
  `theta`, `rho`, `alpha`, etc. ?

## Commandes de dictée

- [ ] Quelle forme orale canonique utiliser pour « retour à la ligne », nouveau
  paragraphe et les commandes de bloc mathématique ?
- [ ] Comment demander explicitement une ponctuation lorsque celle-ci compte
  réellement pour le texte inséré ?

## Annotation et mesure

- [ ] La couche 1 conserve-t-elle seulement les mots prononcés, sans
  ponctuation éditoriale ?
- [ ] Quelle ponctuation reste significative dans le score strict, en plus du
  CER acoustique sans ponctuation ?
- [ ] Comment noter une hésitation, une répétition ou une autocorrection orale ?
- [ ] Que faire lorsqu'une même formulation orale admet plusieurs couches 2
  plausibles ?

## Format pour une nouvelle question

- Date :
- Exemple audio ou segment :
- Formulation orale :
- Couches 1 et 2 envisagées :
- Pourquoi c'est ambigu :
- Décision : ouverte / décidée / abandonnée