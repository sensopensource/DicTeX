# Registre des conventions

Ce document recueille les questions découvertes pendant les dictées réelles.

Ce n'est pas une spécification : une question ouverte ne bloque ni la collecte
ni un benchmark. Chaque question reçoit un identifiant stable `CONV-NNN`.
Lorsqu'une décision est prise, la question n'est ni supprimée ni renumérotée :
elle est marquée comme décidée et pointe vers l'entrée durable correspondante
de `docs/product-decisions.md`, avec des exemples et une date.

## Décisions issues du registre

### CONV-016 — Représentation lexicale de la couche 1

- Statut : décidée le 13 juillet 2026.
- Décision : voir `DEC-COUCHE1-001` dans `docs/product-decisions.md`.
- Principe : la référence acoustique conserve les mots prononcés en français et
  ne les remplace pas par une notation mathématique compacte.
- Exemples : `theta`, pas `θ` ; `trois`, pas `3` ; `x au carré`, pas
  `x²` ou `x^2` ; `sinus`, pas `sin`.
- Limite : cette décision ne fixe pas encore toute l'orthographe des nombres
  composés, la ponctuation éditoriale ni la manière d'annoter les hésitations.

### CONV-001, CONV-002, CONV-003, CONV-004 et CONV-007 — Fonctions et unités explicites

- Statut : décidées le 13 juillet 2026.
- Décision : voir `DEC-COUCHE2-001` dans `docs/product-decisions.md`.
- Principe : une couche 2 est déduite du seul segment courant et n'invente ni
  unité, ni base logarithmique, ni opérande grâce au contexte.
- Exponentielle : « exponentielle de A » et « e puissance A » produisent
  `$e^{A}$` ; « e » désigne la constante ; « exponentielle » seule ne désigne
  jamais `e`. « Exponentielle x » sans « de » n'a pas de cible automatique.
- Logarithmes : « logarithme de A » conserve une base non spécifiée avec
  `$\log(A)$` ; `\ln` exige « ln », « logarithme naturel » ou « logarithme
  népérien » ; la base dix exige « logarithme décimal ».
- Angles : `^\circ` n'est produit que si « degré » ou « degrés » est prononcé.
  Le mot « angle » introduit un argument, pas une unité, et un segment
  n'hérite jamais de l'unité du précédent.

### CONV-005 — Décimaux

- Statut : décidée le 15 juillet 2026.
- Décision : voir `DEC-COUCHE2-002` dans `docs/product-decisions.md`.
- Couche 1 : partie entière, « virgule », puis chiffres décimaux prononcés un
  par un ; par exemple « zéro virgule zéro zéro un ».
- Couche 2 : virgule française protégée en LaTeX ; l'exemple devient
  `$0{,}001$`.
- Frontière : « virgule » n'est décimale qu'entre une partie entière reconnue et
  au moins un chiffre explicitement prononcé. Sinon, elle reste prose ou
  ponctuation.

## Notation et vocabulaire mathématique

- [ ] **CONV-006 — Orthographe des nombres composés.** Quelle orthographe
  canonique conserver dans la couche 1, par exemple « quatre-vingts »,
  « quatre-vingt-dix » et « cent quatre-vingts » ?
- [ ] **CONV-008 — Relations d'ordre.** Quelle différence orale retenir entre
  « inférieur à », « strictement inférieur à » et « inférieur ou égal à » ?
- [ ] **CONV-009 — Relations chaînées.** Comment désambiguïser les chaînes comme
  « a inférieur à b inférieur à c » ?
- [ ] **CONV-010 — Portée des opérateurs.** Quelle portée donner à « moins »,
  « sur », « racine de », « puissance de » et « indice » ? Quand les
  parenthèses orales deviennent-elles obligatoires ?
- [ ] **CONV-011 — Formulation des limites.** Faut-il standardiser
  `\lim_{x \to a} f(x)` comme « la limite de f de x quand x tend vers a » ?
  - Exemple : « la limite de un sur x quand x tend vers plus l'infini est
    égale à zéro ».
  - Alternative plus soutenue : « la limite, quand x tend vers plus l'infini,
    de un sur x est égale à zéro ».
  - À trancher : « quand » ou « lorsque », et la règle qui borne proprement
    l'expression dont la limite est prise.
- [ ] **CONV-012 — Noms des lettres grecques.** Quelles formes orales et
  orthographes françaises canoniques choisir : `theta`, `rho`, `alpha`, etc. ?
  La sous-décision « mot en couche 1 plutôt que symbole grec » est déjà fixée
  par `DEC-COUCHE1-001` ; cette question porte sur le lexique exact.

## Commandes de dictée

- [ ] **CONV-013 — Commandes de bloc.** Quelles formes orales canoniques
  ajouter pour ouvrir et fermer un bloc mathématique ? `retour à la ligne` et
  `nouveau paragraphe` sont déjà les formes canoniques implémentées.
- [ ] **CONV-014 — Sauts de ligne.** Quel contrat donner aux sauts de ligne ?
  - La sortie STT brute est-elle un bloc unique par segment, les retours émis
    par le moteur étant traités comme des espaces ?
  - Le texte inséré ne crée-t-il une nouvelle ligne que sur une commande orale
    explicite comme « retour à la ligne » ?
  - Faut-il éviter toute consigne de saut de ligne dans l'`initial_prompt` ?
  - Les retours de ligne de formatage du moteur comptent-ils comme des espaces,
    et non comme de la ponctuation, pour le scoring acoustique ?
- [ ] **CONV-015 — Ponctuation dictée.** Comment demander explicitement une
  ponctuation lorsque celle-ci compte réellement pour le texte inséré ?

## Annotation et mesure

- [ ] **CONV-017 — Ponctuation de couche 1.** La couche 1 conserve-t-elle les
  mots prononcés sans ponctuation éditoriale ajoutée ? La représentation
  lexicale des mots est décidée par `DEC-COUCHE1-001`, mais la ponctuation reste
  ouverte.
- [ ] **CONV-018 — Ponctuation du score strict.** Quelle ponctuation reste
  significative dans le score strict, en plus du CER acoustique sans
  ponctuation ?
- [ ] **CONV-019 — Disfluences.** Comment noter une hésitation, une répétition
  ou une autocorrection orale ?
- [ ] **CONV-020 — Cibles multiples.** Que faire lorsqu'une même formulation
  orale admet plusieurs couches 2 plausibles ?

## Format pour une nouvelle question

- Identifiant : `CONV-NNN`
- Titre :
- Statut : ouverte / décidée / abandonnée
- Date :
- Exemple audio ou segment :
- Formulation orale :
- Couches 1 et 2 envisagées :
- Pourquoi c'est ambigu :
- Impact sur le scoring :
- Impact sur les données existantes :
- Décision liée : `DEC-…` / aucune
