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

## Notation et vocabulaire mathématique

- [ ] **CONV-001 — Angle nul.** Pour `0^\circ`, quelle formulation orale
  privilégier : « zéro degré » ou « angle zéro » ? Quelle cible LaTeX canonique
  en découle ?
- [ ] **CONV-002 — Exponentielle.** Faut-il dire « e puissance x » ou
  « exponentielle de x » ? La couche 2 produit-elle `e^x` ou `\exp(x)` ?
- [ ] **CONV-003 — Logarithme naturel.** Faut-il dire « logarithme de x », « ln
  de x » ou « logarithme népérien de x » ? Quelle différence orale réserver à
  `log` ?
- [ ] **CONV-004 — Constante e.** Comment annoncer la constante `e` sans la
  confondre avec une lettre ou un mot mal entendu ?
- [ ] **CONV-005 — Décimaux.** Quelle forme orale retenir, par exemple « zéro
  virgule deux » et « vingt virgule zéro huit cinq » ? Comment séparer cette
  virgule décimale de la ponctuation de phrase ?
- [ ] **CONV-006 — Orthographe des nombres composés.** Quelle orthographe
  canonique conserver dans la couche 1, par exemple « quatre-vingts »,
  « quatre-vingt-dix » et « cent quatre-vingts » ?
- [ ] **CONV-007 — Formulation trigonométrique.** Faut-il dire « sinus de x »
  ou « sinus de l'angle x » ? Comment annoncer explicitement degrés et radians ?
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
