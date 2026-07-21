# Product Decisions

This document captures the product and implementation context that future agents should preserve when working on DicTeX.

> **Direction actuelle :** `docs/roadmap.md` est la source canonique de l'ordre
> des travaux. Ce document conserve les décisions durables ; les sections
> anglaises antérieures restent comme historique. Toute nouvelle décision est
> rédigée en français conformément à `CONTRIBUTING.md`.

## Décisions de la boucle quotidienne — 10 juillet 2026

- **Cahier externe :** Typora est le premier environnement réel. Zettlr est le
  repli si une friction concrète apparaît. DicTeX ne possède toujours pas les
  documents.
- **Format :** prose Markdown et LaTeX canonique. `$…$` est implémenté pour les
  mathématiques en ligne ; un mécanisme explicite `$$…$$` est la prochaine
  extension du contrat. Le rendu appartient au cahier, pas au normaliseur.
- **Contrôle :** le normaliseur est activable manuellement et son état persiste
  (#105). Aucun changement automatique selon l'application cible pour l'instant.
- **Interaction :** les libellés anglais Start/Stop doivent partager le même
  état entre le bouton et `Win+Alt+Space` (#96).
- **Latence :** DicTeX doit garder un seul modèle STT actif dans un processus
  Python persistant. Le chargement initial et la transcription chaude sont deux
  mesures distinctes.
- **Contexte STT :** le `initial_prompt` de faster-whisper est choisi par une
  comparaison sur `validation` (#94), jamais par intuition ni sur
  `test_frozen`.
- **Correction :** la correction visible reste d'abord dans le cahier ; le Lab
  qualifie ensuite les exemples en couches acoustique et mathématique.
- **Apprentissage :** règles d'abord, petit modèle sur le résidu ensuite,
  adaptation acoustique en dernier et seulement si le résidu le justifie.
- **Langue du projet :** commits, tickets, demandes de fusion, revues et
  documents en français ; code, commentaires techniques, tests, journaux et
  interface en anglais pour l'instant.

## DEC-COUCHE1-001 — Transcription lexicale littérale — 13 juillet 2026

**Statut : active.** La cible humaine d'une correction `acoustic`, donc la
couche 1 utilisée par les benchmarks et un futur entraînement STT, conserve les
mots effectivement prononcés en français. Elle ne remplace pas ces mots par une
notation mathématique compacte choisie par le décodeur.

Premières formes fixées :

| Formulation prononcée | Couche 1 canonique | Formes non canoniques en couche 1 |
| --- | --- | --- |
| « theta » | `theta` | `θ` |
| « trois » | `trois` | `3` |
| « x au carré » | `x au carré` | `x²`, `x^2` |
| « sinus » | `sinus` | `sin` |

La couche 2 reste chargée de la notation mathématique. Les cibles LaTeX exactes
restent régies par leurs propres décisions : cette entrée ne tranche notamment
pas encore `e^x` contre `\exp(x)` ni `\sin x` contre `\sin(x)`.

Cette décision ne transforme pas `initial_prompt` en garantie : le prompt ne
fait que biaiser le décodage. La correction humaine `acoustic`, contrôlée contre
l'audio, reste la source de vérité, et le Lab doit mesurer les violations de
convention en plus du CER général. Le `stt_result` brut n'est jamais réécrit.
Une vue dérivée peut canonicaliser un cas démontré sans ambiguïté, mais `x²` ne
permet déjà plus de savoir si la personne a dit « x au carré » ou « x puissance
deux », et un nombre compact perd souvent sa formulation orale exacte.
L'orthographe des nombres composés, la ponctuation et les disfluences restent
ouvertes dans `docs/questions-de-conventions.md`.

## DEC-COUCHE1-002 — Orthographe canonique des nombres composés — 20 juillet 2026

**Statut : décidée, non encore implémentée dans le normaliseur.** CONV-006 est
tranchée pour la couche 1 (référence CER) : l'orthographe traditionnelle
française du nombre composé fait foi, jamais sa conversion en chiffres.

- Trait d'union entre les éléments inférieurs à cent : `dix-sept`,
  `quatre-vingt-dix`.
- `et` sans trait d'union devant `un` : `vingt et un`.
- `vingt` et `cent` prennent un `-s` lorsqu'ils sont multipliés et non suivis
  d'un autre nombre : `quatre-vingts`, `deux cents` ; mais `quatre-vingt-dix`
  et `deux cent un` restent invariables, puisqu'ils sont suivis.
- `mille` reste invariable dans tous les cas.
- Aucun trait d'union autour de `cent` ou `mille` : `cent quatre-vingts`.

Cette décision reste une convention de couche 1 : `DEC-COUCHE1-001` continue de
garder les mots effectivement prononcés ; cette entrée fixe seulement laquelle
de leurs orthographes fait foi. Elle ne convertit aucun nombre composé en
chiffres.

## DEC-COUCHE1-003 — Lexique canonique des lettres grecques — 20 juillet 2026

**Statut : implémentée dans le normaliseur** (jeu livré v6, #178). CONV-012 est
tranchée : la couche 1 des lettres grecques minuscules utilise l'ASCII
minuscule sans accent, identique au nom de la macro LaTeX correspondante :

`alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, lambda, mu,
nu, xi, pi, rho, sigma, tau, upsilon, phi, chi, psi, omega`

`omicron` est volontairement exclu : LaTeX de base n'a pas de macro `\omicron`
(la lettre s'écrit avec un `o` latin ordinaire), donc l'inclure violerait la
règle « identique au nom de la macro LaTeX » ; il reste par ailleurs indistinct
d'un `o` en pratique. Cohérent avec `theta`, déjà fixé par
`DEC-COUCHE1-001`. Le dictionnaire ramène les variantes STT accentuées ou
phonétiques observées vers cette forme canonique, mais n'invente pas un
homophone français risqué : `pie` n'est pas un alias de `pi`. Les atomes `mu`
et `nu` ne consomment pas le mot `un` comme opérande droit, afin que « mu sur un
plateau » et « nu sur un lit » restent de la prose ; leurs autres constructions
non ambiguës restent reconnues. Le `stt_result` brut n'est jamais réécrit. La
casse majuscule
(`\Lambda`) reste un renvoi vers `CONV-021`, qui fixe déjà la casse latine mais
pas encore la casse grecque.

## DEC-RUN-001 — Une mesure STT appartient toujours à un run — 13 juillet 2026

**Statut : active.** Toute mesure STT du Lab naît d'un run tracé : un
`stt_benchmark_run_started` qui fige le snapshot acoustique et les candidats
lancés, des `stt_benchmark_result` portant son `run_id`, puis un
`stt_benchmark_run_finished`. Un résultat sans run n'est plus produit.

Conséquence, appliquée par #138 : le rejeu ad hoc du Lab (`Benchmark latest` et
le benchmark d'un segment isolé) est **retiré**. Il écrivait des
`stt_benchmark_result` sans `run_id`, donc sans snapshot ni référence
explicables, qui se mélangeaient ensuite aux vrais résultats antérieurs à #122
dans le seau « legacy ». Une mesure dont on ne peut pas dire contre quelle
référence elle a été calculée ne sert ni à comparer des candidats, ni à choisir
un `initial_prompt`.

Les résultats sans `run_id` déjà enregistrés restent lisibles sous
`Legacy (pre-run results)` : l'historique est à ajout uniquement et n'est jamais
réécrit. Un futur besoin d'essai rapide devra passer par un run explicite — au
besoin un run à un seul segment — plutôt que par un chemin d'écriture parallèle.

Un run STT ne peut commencer sans segment audio évaluable : cette garde existe
aussi dans le processus principal, avant tout événement `run_started`, car le
preview de l'interface reste une lecture asynchrone. Un segment ne compte comme
`done` que si au moins un candidat a produit une sortie ; si tous les candidats
sont indisponibles, il est consigné dans `failures`. Les rares runs historiques
dont le terminal annonce `done` sans sortie sont conservés tels quels et lus
comme « terminé sans sortie », jamais comme « jamais exécuté », aussi bien dans
`Results` que dans l'export LLM régénérable.

## DEC-RUN-002 — Les nouveaux stages ont leur propre famille de runs — 13 juillet 2026

**Statut : active.** Les événements historiques `stt_benchmark_run_started`,
`stt_benchmark_result` et `stt_benchmark_run_finished` restent le contrat du
writer STT actuel. Ils ne sont ni renommés, ni migrés, ni doublés. Les nouveaux
stages utilisent la famille stage-aware `benchmark_run_started`,
`benchmark_result` et `benchmark_run_finished`, définie dans
`packages/shared/src/benchmarkContract.ts`.

Le contrat n'efface pas les différences d'entrée : ses snapshots et ses
résultats sont des unions discriminées par `stage`.

- `stt` / `acoustic` fige l'audio et la référence humaine de couche 1 ;
- `math_transform` fige une entrée couche 1 et une cible couche 2 textuelles,
  sans audio obligatoire ;
- `end_to_end` est un nom réservé, sans variante d'événement writable tant que
  son entrée, sa cible et ses métriques n'ont pas fait l'objet d'un ticket.

La paire d'un snapshot `math_transform` provient d'un seul événement de
correction : `raw_transcript` devient la couche 1 et `corrected_transcript` la
couche 2 de la dernière correction `math_transform`. Une correction acoustique
postérieure ne reconstruit jamais cette couche 1. Chaque résultat et chaque
failure terminale appartiennent à un couple candidat × membre ; l'identité
candidat commune reste exactement `stage + provider + model + variant`.

Le premier événement de début valide d'un `run_id` fait foi, y compris en cas de
collision entre l'ancienne et la nouvelle famille. Dans la nouvelle famille, le
premier résultat valide d'un couple candidat × membre et le premier terminal
font également foi ; les événements orphelins, hors snapshot, hors candidats ou
postérieurs au terminal ne réécrivent pas la projection. Les slots sans résultat
ni failure restent `missing`, distincts de `done` et `failed`.

Une projection commune de lecture adapte trois sources sans les confondre : les
runs STT suivis existants, le seau virtuel des résultats STT antérieurs aux runs,
et les nouveaux runs stage-aware. L'état historique
`completed_without_output` de #138 reste réservé à l'adaptateur STT pour ne pas
perdre cette contradiction ancienne. Les résumés, l'interface et l'export LLM
STT existants gardent leurs lecteurs et leurs octets à état égal ; #139 ajoute
un contrat de lecture, pas un nouveau writer STT.

## DEC-RUN-003 — La référence du normaliseur mesure la paire textuelle figée — 13 juillet 2026

**Statut : active.** Le premier run `math_transform` du Lab mesure exclusivement
`couche 1 -> normaliseur déterministe -> couche 2`. Il ne relit aucun audio et
ne mélange donc jamais une erreur STT à une erreur de règle. Son snapshot copie
la paire et la date portées par la dernière correction `math_transform` de
chaque membre du split au moment du lancement ; une recorrection ultérieure ne
change ni le détail ni le score historique.

Le candidat unique porte `stage=math_transform`, `provider=dictex`,
`model=deterministic-pipeline`. Son `variant` contient les SHA-256 complets du
dictionnaire et des règles chargés dans l'instance qui exécute le run. Le nom
court affiché reste `Current deterministic pipeline` : les hash appartiennent à
la provenance, pas au libellé principal. Si les fichiers changent après la
prévisualisation du protocole, le lancement est refusé avant tout événement et
doit être rafraîchi.

Le pipeline exécuté est l'unique normaliseur partagé : dictionnaire, extraction
des commandes, règles regex. Avant chaque `benchmark_result`, les sentinelles de
commande sont restaurées en mots canoniques dans la sortie et dans toutes les
traces ; aucun caractère PUA n'est écrit. La mesure est l'exact match après
`canonicalizeLatex`, sans équivalence mathématique ou réparation sémantique.
Une portée erronée reste donc un échec visible et explicable par le diff et les
traces de couches dans `Results`.

## DEC-RUN-004 — L'export LLM du normaliseur appartient entièrement au run — 13 juillet 2026

**Statut : active.** Un futur `benchmark_run_started` de stage
`math_transform` fige désormais la configuration effective chargée par
l'instance de `TranscriptNormalizer` qui exécute le run : sources et empreintes
du dictionnaire et des regex, définitions retenues ou ignorées, table de
commandes, versions sémantiques du pipeline et de la canonicalisation LaTeX.
L'identité du candidat inclut ces versions et l'empreinte des commandes en plus
des empreintes du dictionnaire et des règles.

Le mode de trace détaillé est demandé uniquement par ce benchmark. Les événements
de dictée quotidienne gardent leurs traces de couches historiques, sans les
occurrences par définition. Pour le run, chaque opération réellement rencontrée
référence un identifiant défini une seule fois dans le snapshot et porte ses
positions et fragments propres au segment. Les mots de commande sont restaurés
avant l'écriture ; une source contenant un caractère PUA le représente sous une
forme échappée, jamais comme caractère brut.

`Export for LLM` construit exclusivement depuis le start, les résultats et le
terminal de ce run un dossier contenant exactement `manifest.json`,
`dataset.math_transform.jsonl` et `outputs.jsonl`. L'export ne relit ni corpus,
ni split, ni fichier courant. Un run antérieur sans snapshot complet ou sans
traces détaillées est refusé et doit être relancé ; sa provenance n'est jamais
reconstituée. Le manifeste contient volontairement le dictionnaire personnel et
l'interface l'annonce. DicTeX ne téléverse rien.

## DEC-NORM-001 — Les nouvelles expressions restent atomiques — 15 juillet 2026

**Statut : active pour la sémantique des règles ; stockage local remplacé par
DEC-NORM-002.** Le jeu livré de règles du normaliseur passe à la version 2
et couvre davantage de formulations locales sans devenir un parseur. Un atome
reste une lettre, un entier signé ou non, ou l'un des noms grecs explicitement
pris en charge (`theta`, `rho`). Les nombres français de zéro à vingt et la forme
`moins N` ne deviennent des chiffres que lorsqu'ils occupent effectivement la
place d'un opérande dans une construction reconnue ; les mêmes mots en prose
restent inchangés.

Les fonctions `sinus de A`, `cosinus de A`, `logarithme naturel de A` et
`f de A` consomment exactement un atome. Les fractions `A sur B` et
`A divisé par B` font de même. Les opérations internes — fractions, fonctions,
multiplications, additions et soustractions — passent avant les égalités et les
comparaisons afin que `v égal d sur t` devienne `$v = \frac{d}{t}$`. Cette
priorité ne donne aucune portée arbitraire aux regex : elles ne construisent ni
parenthèses implicites, ni argument composé, ni arbre mathématique.

La version sémantique du pipeline devient
`dictex-deterministic-pipeline-v3`. Le snapshot des runs continue de conserver
les définitions effectives ordonnées, la source complète et son SHA-256 ; le
jeu absent par défaut et un fichier `rules.json` existant restent donc
distinguables. DicTeX ne modifie jamais automatiquement un fichier utilisateur.
La procédure manuelle initiale est remplacée par la migration explicite et non
destructive de DEC-NORM-002.

## DEC-NORM-002 — Jeu livré versionné et surcouche personnelle — 15 juillet 2026

**Statut : active.** Les règles livrées vivent uniquement dans le code partagé,
avec une version de jeu, un identifiant stable indépendant du contenu et un
ordre explicite. La configuration utilisateur `rules-overlay.json` ne recopie
pas ce jeu : elle peut désactiver un identifiant, le remplacer à sa position ou
ajouter des règles personnelles ordonnées. `packages/shared` est l'unique lieu
où le jeu courant et cette surcouche sont composés, compilés, diagnostiqués et
hachés. DicTeX, préremplissage, export et benchmark consomment le même chargeur.

Un `rules.json` historique reste actif sans surcouche afin de préserver une
baseline reproductible, mais le Lab l'annonce comme legacy et ne confond jamais
la version sémantique du pipeline avec le jeu réellement exécuté. La migration
n'a lieu qu'après prévisualisation, résolution explicite des ambiguïtés et
confirmation. Elle reconnaît les signatures livrées v1/v2/v3, conserve toute règle
inconnue comme personnelle, crée une sauvegarde horodatée sans écrasement, écrit
la surcouche atomiquement et produit un reçu limité aux chemins, versions et
empreintes. L'original n'est ni supprimé ni réécrit.

La provenance distingue version et SHA-256 du jeu livré, SHA-256 de la source
locale éventuelle et SHA-256 des définitions effectives. Un nouveau run fige
aussi les définitions ordonnées ; les variantes historiques restent lisibles
par leurs anciens schémas. Cette extension porte le contrat du pipeline à 3 et
sa version sémantique à `dictex-deterministic-pipeline-v4`. Une mise à jour
future du jeu livré devient ainsi
effective automatiquement, tandis que désactivations et remplacements
continuent de viser les mêmes identifiants stables.

## DEC-NORM-003 — Promotion des motifs structurés validés — 15 juillet 2026

**Statut : active.** Le jeu livré est à la version 6 et la version sémantique
du pipeline est `dictex-deterministic-pipeline-v8`. Son empreinte effective est
`a76c2c5556ca152854ca66c2894f8115161c0099fccbb5e9e9e2276b1ec95a1d`.

<!-- dictex-contract: normalizer-bundled-rules version=6 semantic-version=dictex-deterministic-pipeline-v8 sha256=a76c2c5556ca152854ca66c2894f8115161c0099fccbb5e9e9e2276b1ec95a1d -->

La variante expérimentale `combined-structured-feminine-comparisons-v3`,
d'empreinte SHA-256
`86204019a1bca8a0585400365b61cd49aa6a64f5bbf0e61ca88a88461a3959e9`, a été
rejouée sur les 21 exemples figés de `validation` du run
`run_20260715131235469_r1xsgn7a`. Elle passe de 7 à 20 correspondances exactes,
sans régression sur les sept succès initiaux et sans diagnostic.

Les nouveaux motifs restent déterministes et bornés. Ils reconnaissent quelques
formulations explicites observées : parenthèses dictées autour d'une somme ou
d'une différence simple, carré de ce groupe, deux fonctions d'une lettre
imbriquées, deux limites canoniques, une dérivée, une intégrale bornée, une
exponentielle atomique, une expression affine et certains identifiants annoncés
par un contexte mathématique. Les nombres de zéro à vingt sont générés dans ces
seuls contextes. Ce jeu n'est ni une grammaire générale ni un parseur : il ne
déduit aucune parenthèse silencieuse et ne choisit aucune portée non dictée.

Le résidu « racine carrée de a plus b » reste volontairement conservé en
l'absence de marqueur : la règle atomique produit `\sqrt{a} + b`, car décider
`\sqrt{a+b}` sans marque de groupe serait une convention de portée, pas une
substitution sûre. La version 5 ajoute le marqueur oral « le tout »
(`DEC-CONV-003`, CONV-010), seule façon explicite de lever ce résidu :
`racine carrée de a plus b le tout` produit alors `\sqrt{a+b}`, et « le tout »
borne de même le carré, le cube, la puissance et la fraction de l'expression
`$…$` déjà formée qui le précède, toujours sans parenthèse déduite.

Les identifiants des 66 règles v2 et des 160 définitions v4 restent inchangés ;
les sept nouvelles règles « le tout » reçoivent leurs propres identifiants
stables (`group-marker-*`). Une surcouche ancienne continue donc à désactiver ou
remplacer la même règle, tout en consommant automatiquement les nouvelles
définitions livrées.

La version 6 implémente le lexique grec complet de `DEC-COUCHE1-003` (CONV-012,
#178) : les vingt-trois lettres grecques minuscules — `omicron` exclu, faute de
macro `\omicron` en LaTeX de base — deviennent des atomes reconnus dans les
constructions existantes et produisent leur macro `\<lettre>`. Le dictionnaire
des variantes STT accentuées ou phonétiques (`thêta`, `rhô`, `khi`, …)
est livré comme alias d'atomes, DicTeX livrant un dictionnaire personnel vide ;
comme tout atome, une variante n'est canonicalisée qu'à l'intérieur d'une
construction. Une homophonie française spéculative n'est toutefois pas livrée :
`pie` reste toujours de la prose et seule la forme canonique `pi` est reconnue.
Pour `mu` et `nu`, la construction reste volontairement inchangée lorsque
l'opérande suivant est le mot `un`, afin de préserver « mu sur un plateau »,
« nu sur un lit » et « nu plus un » ; un opérande non ambigu (`mu sur x`,
`nu plus deux`) reste reconnu. Ces règles sont ajoutées au seul jeu courant : les
66 règles v2, les 160 définitions v4 et les sept règles « le tout » gardent
leurs identifiants et leurs effectifs. Leurs motifs reconstruits utilisent
explicitement le seul lexique historique `theta|rho`, et des fixtures issues des
fichiers v2/v3 livrés figent désormais leurs signatures de migration. Les
nouvelles règles portent des identifiants stables
`spoken-atom-left-<lettre>` / `spoken-atom-right-<lettre>` (et un slug dédié par
variante), et `GREEK_LATEX_NAMES` accueille les vingt-trois macros pour que
`\<lettre>` soit un opérande atomique partout.

## DEC-COUCHE2-001 — Transformation locale sans inférence sémantique — 13 juillet 2026

**Statut : active.** Une cible humaine `math_transform` doit pouvoir être
déduite de la seule couche 1 du segment courant. Elle ne récupère aucune unité,
base de logarithme, opérande ou intention dans un segment voisin et ne corrige
pas une affirmation parce qu'elle paraît mathématiquement fausse. La couche 2
nettoie la forme parlée et produit la notation canonique ; elle n'invente pas le
contenu mathématique.

Cette règle est volontairement fermée : lorsqu'une information nécessaire
n'est pas prononcée, le Lab conserve la paire acoustique mais aucune cible
`math_transform` n'est créée tant que le segment n'est pas redicté explicitement
ou qu'une convention ultérieure ne rend la transformation déterministe. Une
cible plausible grâce au contexte humain ne devient pas une vérité
d'entraînement.

Les formes suivantes sont fixées :

| Formulation de couche 1 | Couche 2 canonique | Règle |
| --- | --- | --- |
| `exponentielle de A` | `$e^{A}$` | l'expression prononcée est l'exposant |
| `e puissance A` | `$e^{A}$` | même cible canonique |
| `e` | `$e$` | constante explicite |
| `exponentielle` sans opérande | aucune cible automatique | ne signifie jamais la constante `e` |
| `logarithme de A` | `$\log(A)$` | base laissée non spécifiée |
| `logarithme naturel de A`, `logarithme népérien de A` ou `ln de A` | `$\ln(A)$` | base naturelle explicite |
| `logarithme décimal de A` | `$\log_{10}(A)$` | base dix explicite |
| `sinus de quatre-vingt-dix degrés` | `$\sin(90^\circ)$` | l'unité est prononcée |
| `sinus de quatre-vingt-dix` | `$\sin(90)$` | aucun degré n'est ajouté |
| `sinus de l'angle alpha` | `$\sin(\alpha)$` | « angle » introduit l'argument, pas son unité |

Les mêmes règles d'unité valent pour cosinus, tangente et les autres fonctions
trigonométriques. Dire « angle quatre-vingt-dix » ne suffit pas à produire
`90^\circ` ; il faut dire « quatre-vingt-dix degrés ». Une base logarithmique ou
une unité angulaire mentionnée dans le segment précédent ne se propage jamais.

Conséquences pour les données :

- une formulation incomplète comme « logarithme de l'exponentielle est égal à
  un » reste acoustiquement valide, mais n'a pas de cible mathématique sûre ;
- une identité destinée au logarithme naturel doit prononcer `ln`, « logarithme
  naturel » ou « logarithme népérien » ;
- « exponentielle x » sans « de » reste acoustiquement valide, mais n'a pas de
  cible automatique ; il faut prononcer « exponentielle de x » ou « e puissance
  x » ;
- un segment trigonométrique sans le mot « degrés » produit un argument sans
  symbole `^\circ`, même si le sujet général de la dictée porte sur les degrés ;
- une nouvelle prise explicite est préférable à une correction de couche 2 qui
  dépendrait d'un contexte absent de son entrée.

## DEC-COUCHE2-002 — Décimaux français explicites — 15 juillet 2026

**Statut : active.** La forme orale canonique d'un décimal énonce la partie
entière, le mot « virgule », puis chaque chiffre décimal séparément. La couche 1
conserve exactement cette verbalisation : « zéro virgule zéro zéro un », jamais
`0,001`. La couche 2 produit la virgule française protégée en LaTeX :
`$0{,}001$`. Le même contrat donne « vingt virgule zéro huit cinq » →
`$20{,}085$`.

Le mot « virgule » n'est interprété comme séparateur décimal que dans une
séquence numérique complète : une partie entière reconnue avant lui et au moins
un chiffre explicitement prononcé après lui. Hors de ce cadre, il reste de la
prose ou de la ponctuation et ne crée aucune cible décimale. Les chiffres après
la virgule ne sont ni regroupés ni inférés : « zéro virgule un » vaut
`$0{,}1$`, tandis que `$0{,}01$` exige « zéro virgule zéro un ».

Cette décision ne transforme pas « point » ou « virgule » en mots de commande
et ne tranche pas l'orthographe générale des nombres composés, qui reste suivie
par `CONV-006`.

## DEC-CONV-001 — Grammaire orale explicite et déterministe — 15 juillet 2026

**Statut : active.** Les conventions orales suivent le principe « une
formulation canonique, une structure explicite, une couche 2 ». Toute
information nécessaire à la cible est prononcée dans le segment courant ; le
normaliseur ne récupère ni dimension, ni portée, ni casse, ni séparateur dans le
contexte mathématique. Les principes complets et la passe de création des paires
sont fixés dans `docs/principes-des-conventions.md`.

Les formes suivantes sont décidées :

| Formulation de couche 1 | Couche 2 canonique | Limite |
| --- | --- | --- |
| `grand f` | `$F$` | seulement devant le nom d'une lettre latine unique |
| `petit f` | `$f$` | même portée bornée |
| `parenthèse ouvrante x parenthèse fermante` | `$(x)$` | les délimiteurs sont prononcés |
| `x séparateur y` dans une structure délimitée | `x,y` | virgule structurelle, jamais décimale |
| `zéro virgule zéro` | `$0{,}0$` | la décision décimale `DEC-COUCHE2-002` reste inchangée |

Ainsi, « parenthèse ouvrante zéro séparateur zéro parenthèse fermante » produit
`$(0,0)$`, sans collision avec le décimal « zéro virgule zéro ». « Vecteur nul »
ne produit jamais `(0,0)` ou `(0,0,0)` : ces coordonnées et leur dimension ne
sont pas présentes dans la formulation.

Cette décision fixe le contrat de données, pas la couche technique qui réalisera
chaque transformation. Une convention décidée reste signalée comme non
implémentée tant que le dictionnaire, la table de commandes ou les regex ne la
prennent pas effectivement en charge et ne possèdent pas leurs tests.

## DEC-CONV-002 — Relations d'ordre et chaînes — 20 juillet 2026

**Statut : décidée, non encore implémentée dans le normaliseur.** CONV-008 et
CONV-009 sont tranchées. Pour une comparaison simple, `inférieur à` et
`strictement inférieur à` désignent tous deux `<` ; `inférieur ou égal à`
produit `\le`. Par symétrie, `supérieur à` et `strictement supérieur à`
désignent `>` ; `supérieur ou égal à` produit `\ge`. Les synonymes `plus petit
que` et `plus grand que` restent alignés respectivement sur `inférieur à` et
`supérieur à`.

Plusieurs formulations orales peuvent donc viser le même symbole : seul « ou
égal à » change effectivement le symbole produit ; « strictement » ne fait que
répéter explicitement le sens déjà strict de la comparaison simple.

Une relation chaînée (CONV-009) se lit par application répétée de la même règle,
chaque comparaison conservant son propre symbole, sans réordonnancement ni
regroupement déduit : `a inférieur à b inférieur à c` → `$a < b < c$`, et
`a inférieur ou égal à b inférieur à c` → `$a \le b < c$`. La chaîne n'introduit
aucune sémantique nouvelle par rapport aux comparaisons simples qui la composent.

## DEC-CONV-003 — Marqueur de regroupement oral « le tout » — 20 juillet 2026

**Statut : implémentée dans le normaliseur** (jeu livré v6,
`dictex-deterministic-pipeline-v8`, règles `group-marker-*`). Ce marqueur
répond au périmètre de CONV-010 (« quand les parenthèses orales deviennent-elles
obligatoires ») et sert de brique à CONV-011 : « le tout » est le marqueur oral
explicite qui borne l'expression immédiatement précédente déjà formée. Aucune
parenthèse n'est jamais déduite silencieusement en son absence.

| Couche 1 | Couche 2 |
| --- | --- |
| `a plus b le tout au carré` | `$(a + b)^{2}$` |
| `a plus b le tout sur c plus d le tout` | `$\frac{a+b}{c+d}$` |
| `racine carrée de a plus b le tout` | `$\sqrt{a+b}$` |

« le tout » ne borne que l'expression qui le précède immédiatement : dans une
fraction, chaque opérande composé exige donc son propre marqueur. `a plus b le
tout sur c plus d` seul produirait `$\frac{a+b}{c} + d$` (la fraction `A sur B`
ne consomme qu'un atome, `DEC-NORM-001`) ; grouper le dénominateur `c + d`
suppose de le prononcer `c plus d le tout`, faute de quoi la portée reste
atomique et aucune parenthèse n'est déduite. Le dernier exemple lève de même
explicitement le résidu volontairement conservé par `DEC-NORM-003` (`racine
carrée de a plus b`, sans marqueur, reste `\sqrt{a} + b`).

## DEC-CONV-004 — Formulation canonique des limites — 20 juillet 2026

**Statut : décidée, non encore implémentée dans le normaliseur.** CONV-011 est
tranchée : deux placements de la clause « quand/lorsque … tend vers … » sont
canoniques et produisent la même couche 2.

- Postfixe : `la limite de <expr> quand x tend vers a`.
- Infixe soutenu : `la limite, quand x tend vers a, de <expr>`.

`quand` et `lorsque` sont des synonymes interchangeables. Une `<expr>`
composée doit être bornée par « le tout » (`DEC-CONV-003`) pour rester
déductible ; une `<expr>` atomique n'a pas besoin de ce marqueur.

## DicTeX / Lab split (monorepo)

DicTeX est séparé en deux applications Electron dans un même monorepo npm
(voir `pivot_dictex_lab_split.md` et `docs/roadmap.md`) :

- **`apps/dictex`** — the consumer dictation tool (voice → STT → normalizer →
  insert). Has the microphone, hotkey, clipboard/paste, and normalizer.
- **`apps/lab`** — **DicTeX Lab**, the ML tooling app (pivot Phase 2, #76). No
  microphone: it hosts the STT benchmark (tracked runs, per-run summary, error
  analysis, candidate selection — see DEC-RUN-001), typed corrections,
  benchmark-set split membership, the Vosk provider, and the dataset export.

Data contract (file-based, zero code coupling): the Lab keeps DicTeX's audio and
events **read-only** and uses its **own** store for corrections, splits,
benchmark results, candidate selections, exports and settings. La seule
exception d'écriture dans la source est la migration de règles confirmée par
l'utilisateur, limitée à la surcouche, aux sauvegardes et au reçu sous
`normalizer/`. Le store propre reste sous son Electron `userData`
(`%APPDATA%/dictex-lab-app/data`), never DicTeX's `%APPDATA%/dictex-app/data`.
The DicTeX data folder path is configurable in the Lab (default
`%APPDATA%/dictex-app/data`). Both apps import all derivation/scoring/export
logic from `packages/shared` so the two apps cannot diverge; DicTeX never
depends on the Lab.

Phase 2 (#76) added the Lab and factored the shared logic. Phase 3 (#77) then
**removed** the benchmark/dataset/correction/split features from `apps/dictex`,
leaving it a pure consumer dictation tool (single Home view, collapsible
Copy/Copy-raw/Play history, and an "Open Lab" launcher). DicTeX Lab is now the
**sole** tooling surface for benchmark, typed corrections, splits, and dataset
export; DicTeX only writes raw dictation data (`audio_segment`, `stt_result`,
`normalization_result`) that the Lab reads. **All four pivot phases (0-4) are
merged** — DicTeX is the lean consumer app and the Lab owns benchmark + dataset
building + export.

## Product Shape

DicTeX is an OpenWhispr-like dictation layer for mathematical writing.

It is not document-first. In the MVP, DicTeX should not own, manage, or edit full documents. It listens, transcribes, transforms later, and inserts output into the currently active application.

Current product loop:

```text
voix
-> STT local
-> normaliseur déterministe facultatif
-> presse-papiers / application active
-> événements locaux
-> correction visible dans un cahier externe
-> qualification typée et évaluation dans DicTeX Lab
```

Future product loop:

```text
voix
-> STT local maintenu en mémoire
-> texte littéral conservé
-> règles déterministes
-> modèle résiduel texte-vers-LaTeX
-> Markdown + LaTeX dans un cahier externe
-> correction rapide + données typées dans le Lab
-> règles, puis modèles seulement après mesure
```

## Current MVP Reality

The implementation currently uses:

- Electron + React + TypeScript for the desktop app.
- Python sidecar for the local STT engine.
- faster-whisper as the local STT engine.
- JSONL event logging for local data capture.
- Windows-first auto-paste.

Do not migrate to Tauri, SQLite, or a document editor; do not integrate a
third-party LLM provider or API key handling; do not add cloud sync or a
multi-user backend — unless there is a specific issue for that direction.

## Data Model Decisions

The MVP is session-first, not document-first.

Use:

```text
session_id
segment_id
audio_ref
stt_result
```

Do not introduce `document_id` into the MVP core path. DicTeX outputs into external apps, so it usually does not know or own the target document.

Each dictation should preserve the audio -> STT output link:

```json
{"event_type":"audio_segment","session_id":"session_...","segment_id":"seg_0001","audio_ref":"audio/session_.../seg_0001.webm"}
```

```json
{"event_type":"stt_result","session_id":"session_...","segment_id":"seg_0001","stt_engine":"faster-whisper","stt_model":"base","stt_output":"...","corrected_transcript":null}
```

This is important even before correction UI exists, because these records are the basis for later STT evaluation and fine-tuning.

## Correction Strategy

Correction is a first-class product concept, but not all correction layers should be implemented immediately.

Keep these layers separate:

- STT correction: audio + raw STT output + corrected transcript.
- Math parsing correction: spoken text + predicted LaTeX + corrected LaTeX.
- Output correction: final inserted text corrected by the user.

Do not collapse all corrections into a single final-output edit, or future training data will be ambiguous.

Store `corrected_transcript: null` in `stt_result` for compatibility, but write human transcript corrections as separate `stt_correction` events. Do not mutate older `stt_result` records.

### Dataset enrichment recording — removed (DicTeX/Lab split)

The in-app two-layer audio→text *recording* capture (issue #66) has been
**removed** from DicTeX. Per the current pivot (see
`pivot_dictex_lab_split.md`), dataset building and benchmarking move to a
separate **DicTeX Lab** app, and DicTeX stays a lean consumer dictation tool.
The Lab has no microphone: it consumes DicTeX's real transcriptions and reads
DicTeX's local data folder. The Dataset view in DicTeX now only exposes the
local dataset **export** (#44) of already-captured corrections, until the Lab
takes that over too.

The two-layer separability principle itself is preserved — it just lives in the
Lab now: acoustic pairs (audio → literal-correct transcript) and math_transform
pairs (literal text → normalized notation) stay separable by encoding the
pipeline stage in which field is filled, still as chained append-only
`stt_correction` events.

### Lab manual two-layer dataset builder (issue #78)

The Lab's `Dataset` view re-implements the manual builder (no microphone):
choose the input (paste a transcription, or pick a DicTeX-recorded segment),
type Layer 1 (literal) and optionally Layer 2 (notation), pick a benchmark-set
split, and save. See `docs/development.md` → "Dataset builder" for the full
data flow. Decisions:

- **An empty layer is skipped, never blended.** Saving never collapses the
  acoustic and math_transform transforms into one record; which correction
  event(s) get written is determined purely by which layer is filled
  (Layer 2 present → math_transform, which always requires Layer 1 since Layer 1
  is its input). A wrong/blended format here would corrupt both datasets (see
  `docs/agent-workflow.md` level-scoring: axis E = 4).
- **An `acoustic` pair requires real audio (a picked segment) — never a paste.**
  A paste source has no audio, so it can only write a math_transform
  (text → text) pair; an acoustic pair (audio → literal) is only written for a
  picked DicTeX segment. This keeps audio-less `acoustic` records — which are
  unusable for STT fine-tuning — out of the acoustic dataset (Opus-max review of
  #78 / PR #82).
- **A pasted (no-audio) entry still needs a string `audioRef` internally.**
  `@dictex/shared`'s `getSttBenchmarkSetSegments` (and therefore
  `buildSttDatasetExport`, reused unmodified) requires a string `audioRef` to
  place a segment into a benchmark-set split; `null` is filtered out there.
  Rather than fork that shared derivation, the Lab uses an internal, local
  convention (`NO_AUDIO_REF = ""`, documented in
  `apps/lab/src/main/datasetBuilder.ts`) for text-only entries, and its own
  `serializeDatasetRecord` maps it back to a genuine `audio_ref: null,
  audio_path: null` in the exported JSONL — the export never claims a fake
  audio file exists for a math_transform-only entry.
- **A picked-segment entry always keeps its real identity and audio.** No
  synthetic ids, no re-resolving: the segment's own `sessionId`/`segmentId`/
  `audioRef` (already read read-only from DicTeX's data folder) are reused
  as-is, so a chained acoustic + math_transform save lands on the same
  segment DicTeX recorded.
- **Export format is untouched.** The builder only produces `stt_correction`
  / `stt_benchmark_set_membership` events in the Lab's own store; export still
  goes through the existing, unmodified `buildSttDatasetExport` /
  `serializeDatasetRecord` path, so builder-made entries are
  test_frozen-compatible by construction, not by a parallel code path.

## UI Direction

The UI should feel like a compact utility app, not a landing page, dashboard, or marketing site.

### Direction « Cahier Seyès » — 16 juillet 2026

Les deux applications consomment la même fondation visuelle depuis
`packages/shared/src/styles.css`. La palette est définie une seule fois par les
tokens `--ink`, `--ink-deep`, `--paper`, `--paper-edge`, `--rule`, `--margin`,
`--pencil`, `--ok`, `--warn`, `--err` et `--activity`. Les composants utilisent
des alias sémantiques dérivés de ces tokens, sans couleur littérale locale.

Le contenu reste sur papier dans tous les thèmes ; seul le bureau derrière le
cahier suit la préférence claire ou sombre du lecteur. Le texte utilise la
police serif partagée ; les raccourcis et les empreintes techniques utilisent la
police mono.

La typographie mathématique est un contrat **réservé**, pas un comportement
actuel. Le token `--font-math` et la règle italique ne ciblent que de vrais
éléments mathématiques rendus (`math`, `mjx-container`) ; aucune surface n'en
produit aujourd'hui. Les sorties normalisées affichent le LaTeX en texte
littéral : il reste donc dans le serif de la prose, sans italique. Le contrat
prendra effet le jour où un moteur de rendu mathématique sera adopté — une
décision produit hors du périmètre de cette fondation, qui précède
volontairement l'habillage des surfaces. La règle reste limitée aux noms
d'éléments mathématiques : l'étendre à un conteneur de transcription mettrait en
italique la prose mêlée au LaTeX. `packages/shared/src/styles.test.ts` verrouille
cette limite.

### DEC-HUD-001 — Le HUD overlay est un miroir, jamais une source — 17 juillet 2026

**Statut : active.** `apps/dictex` possède une seconde fenêtre flottante, le
HUD : sans cadre, transparente, toujours au-dessus, épinglée au coin de la zone
de travail. Elle rend la dictée utilisable sans revenir à la fenêtre principale,
puisque DicTeX colle dans le cahier et non dans lui-même.

Le HUD est **en lecture seule sur des états qui existent déjà**. Chaque état
garde son propriétaire : Home possède le statut de dictée, le résultat du collage
et les transcriptions ; le processus principal possède l'état du worker STT et le
réglage du normaliseur. Le processus principal ne fait que fusionner ces deux
sources et projeter une vue ; le HUD la dessine. Il n'existe donc aucune seconde
source de vérité capable de contredire Home, et une erreur du HUD ne peut changer
que ce qui est affiché — jamais ce qui est transcrit, inséré ou stocké.

Une carte terminée est le snapshot immuable de la dictée qui l'a produite. Le
résultat transporte notamment la politique du normaliseur figée pour ce run et
le fait qu'une transformation a réellement eu lieu ; modifier ensuite le
réglage de la prochaine dictée ne réinterprète jamais le texte déjà inséré et ne
fait pas disparaître sa comparaison brut ↔ normalisé.

La garantie `Audio kept` est elle aussi un fait explicite, jamais une déduction
du seul état `error`. Elle n'apparaît qu'après confirmation de l'écriture du
fichier audio **et** de son événement `audio_segment`. Un refus du microphone,
une erreur de préparation ou une charge IPC incomplète restent sans garantie ;
un échec STT postérieur à cette frontière peut l'afficher.

Le HUD n'est **jamais sur le chemin critique**. Home publie en fire-and-forget,
l'ouverture de la fenêtre est encapsulée, une charge IPC non fiable est ignorée
plutôt que de lever dans le processus principal, et la dictée quotidienne
fonctionne à l'identique sans aucun overlay.

Deux propriétés protègent le collage et ne doivent pas être relâchées. La fenêtre
est `focusable: false` : DicTeX colle en envoyant Ctrl+V à la fenêtre active, donc
un overlay capable de prendre le focus avalerait le collage à la place du cahier.
Elle est traversante par défaut : elle recouvre le cahier et ne doit pas
intercepter un clic destiné au texte en dessous. Le click-through n'est levé que
tant que le pointeur survole réellement l'unique contrôle du HUD, la bascule
normalisé ↔ brut, et il est rendu dès qu'il la quitte.

**La troncature de l'aperçu est obligatoire.** Le HUD est une surface de coup
d'œil, pas un lecteur : le texte se lit dans le cahier. L'aperçu replie les
espaces — y compris les retours à la ligne produits par la commande
correspondante — coupe sur une frontière de mot à ~120 caractères avec `…`, puis
dégrade en « N characters inserted » lorsque couper masquerait l'essentiel de la
dictée. Si la bascule affiche la variante brute, le résumé devient « N raw
characters » : le compte reste toujours lié au texte effectivement visible. Ce
repli ne concerne que l'aperçu ; le texte inséré et tout ce qui est stocké
gardent leurs octets exacts.

Deux limites sont décidées explicitement :

- **Le toast de collage ne nomme pas l'application cible.** DicTeX ne capture
  jamais la fenêtre au premier plan : `pasteClipboardIntoActiveApp` envoie Ctrl+V
  et renvoie un booléen. Nommer l'application supposerait de lire la fenêtre
  active sur le chemin de collage, ce qu'un overlay purement additif n'a pas à
  faire. Le toast lit donc « pasted » ou « copied — press Ctrl+V to insert ».
- **Le HUD ne rend pas les mathématiques.** Conformément à la direction « Cahier
  Seyès » ci-dessus, aucune surface ne rend d'élément mathématique et l'adoption
  d'un moteur de rendu reste une décision produit distincte, hors du périmètre de
  ce ticket. L'aperçu affiche donc le LaTeX en texte littéral, comme toutes les
  autres surfaces.

Preferred direction:

- sober;
- compact;
- functional, utility-like;
- information-dense but not cluttered;
- close to tools like OpenCode/OpenWhispr;
- minimal colors;
- clear status and diagnostics, visible but not noisy.

Avoid:

- large hero sections;
- gradient-heavy marketing screens;
- big decorative typography or decorative animations;
- generic AI SaaS layouts;
- document-editor complexity in the MVP;
- broad settings pages too early.

Useful visible information:

- current status: ready, recording, transcribing, pasted, error;
- global shortcut;
- STT engine/model/language;
- last session and segment;
- transcription duration;
- paste result;
- recent segment history;
- correction state;
- benchmark results;
- data folder / events log access.

La navigation actuelle est séparée par application :

- **DicTeX** conserve une seule vue Home : dictée, normaliseur, modèle STT,
  diagnostic minimal, historique repliable avec copie/réécoute et bouton
  **Open Lab**. Pas de correction, de banc d'essai ou d'ensemble de données
  dans cette application. Le HUD flottant (`DEC-HUD-001`) n'ajoute pas une
  seconde vue : c'est une fenêtre séparée, sans navigation ni réglage, qui
  reflète en lecture seule l'état déjà porté par Home.
- **DicTeX Lab** possède les vues Corpus, Experiments et Results (#136),
  chacune limitée à sa tâche : le corpus et sa qualification, le formulaire
  de lancement d'une expérience, la lecture d'un run figé (#138). Un
  lancement ne montre jamais un résultat, et un résultat n'offre jamais de
  contrôle de lancement.

Ne pas réintroduire dans DicTeX ce que le pivot #75–#78 a extrait. Le
caractère compact, sobre et utilitaire s'applique aux deux applications.

## Shortcut And Insertion Decisions

Default global shortcut:

```text
Win+Alt+Space
```

It is a toggle:

```text
press once -> start recording
press again -> stop, transcribe, paste
```

Global push-to-talk is intentionally deferred because global key release handling is less reliable cross-platform.

Windows auto-paste is implemented first. Linux auto-paste should be a separate issue. On unsupported platforms, copying to clipboard is acceptable.

## STT Decisions

Default STT configuration:

```text
DICTEX_STT_MODEL=base
DICTEX_STT_LANGUAGE=fr
DICTEX_STT_DEVICE=cpu
DICTEX_STT_COMPUTE_TYPE=int8
```

Le français est la première langue parlée cible. Depuis le 10 juillet 2026, le
versionnage et la documentation du projet sont rédigés en français. Le code et
l'interface restent en anglais (`CONTRIBUTING.md`).

Future model comparison should be based on actual stored segments, not assumptions. Useful candidates:

- tiny;
- base;
- small.

Fine-tuning should not happen before enough clean local correction data exists.

## Benchmark Candidates

Benchmarking is stage-aware. A benchmark candidate is identified by:

```text
stage + provider + model + variant
```

Current implemented candidates are STT candidates, for example:

```json
{"stage":"stt","provider":"faster-whisper","model":"base","variant":"cpu-int8-fr"}
```

For faster-whisper, the `variant` encodes the runtime (`device-computeType-language`).
Depuis #131, plusieurs runtimes peuvent être comparés pour un même modèle dans
un seul run via `DICTEX_STT_BENCHMARK_RUNTIMES` (par ex.
`cpu:int8,cuda:float16,cuda:int8_float16`) : le catalogue est le produit
cartésien `modèle × runtime × (baseline + variantes de prompt)`, et chaque
candidat porte un runtime structuré qui configure réellement le sidecar — son
identité ne peut donc pas mentir sur le type de calcul exécuté. Variable absente
= runtime unique historique inchangé. Le Lab ne détecte pas le matériel :
`auto`/`default` sont refusés et un runtime non exécutable échoue au lancement
de faster-whisper, fait échouer le segment entier du run et peut laisser les
résultats partiels des candidats déjà exécutés. Chaque runtime doit donc être
vérifié sur la machine avant le run (voir `docs/development.md`, « Plusieurs
runtimes par modèle dans le benchmark »).

Future candidates may belong to other stages, such as normalization, segment classification, math transform, or correction suggestion. They can include local STT engines, local LLMs, remote LLMs, or rule-based transforms, but candidates should only be compared within the same stage for the same segment.

Do not treat a Whisper STT transcript and a Claude or Qwen math-transform output as the same kind of benchmark artifact. They may share benchmark metadata, but their stage defines what output is being evaluated.

Benchmarking is a first-class evaluation loop for choosing rules, prompts, and
models — not just a developer debugging tool. Do not let the benchmark
architecture get stuck as "Whisper base vs Whisper small": that is only the
first useful benchmark because STT is the first implemented stage. The
long-term goal is to compare candidates by pipeline stage:

```text
segment audio/transcript
-> STT candidates
-> normalization candidates
-> segment classification candidates
-> math transform candidates
-> correction suggestion candidates
```

Future `math_transform`-stage candidates, for example:

```json
{"stage":"math_transform","provider":"qwen","model":"qwen2.5-coder","variant":"local"}
```

```json
{"stage":"math_transform","provider":"claude","model":"claude-sonnet","variant":"remote"}
```

Implement this progressively. Do not build a large generic benchmark
framework before the product needs it, but avoid hardcoding assumptions that
make future model-vs-model comparisons awkward.

### Second local STT provider (Vosk)

The STT benchmark universe must not stay "Whisper base vs Whisper small". To make
it genuinely multi-provider, a second local STT engine was added as a
benchmark-only candidate behind a small provider abstraction in the Python
sidecar (`packages/engine/providers/`): `faster-whisper` is the first provider,
**Vosk** the second.

Why Vosk:

- Different engine family (Kaldi/DNN-HMM), not another Whisper flavour, so the
  benchmark compares real alternatives instead of variants of one model.
- Fully local and offline; pip-installable wheel on Windows with no compilation.
- French acoustic models are available (e.g. `vosk-model-small-fr-0.22`), and it
  is CPU-friendly and lightweight.

Rejected alternatives:

- **whisper.cpp** — still Whisper (same family), and the Windows path needs a
  compiled binary / build toolchain, contrary to the pip-only local setup.
- **Moonshine** — English-only today; the product is French-first.
- **NeMo / other large toolkits** — heavy dependency footprint and not
  CPU-lightweight, disproportionate for a benchmark-only candidate.

Constraints kept:

- Benchmark-only. `faster-whisper` remains the dictation engine; switching the
  dictation engine would be its own issue, justified by the candidate selection
  report.
- Optional at runtime. If the `vosk` package or the local model files are
  absent, the Vosk candidate is skipped with a quiet diagnostic; dictation and
  faster-whisper benchmarking are never blocked.
- Candidate identity is unchanged: `stage="stt"`, `provider="vosk"`,
  `model=<vosk model name>`, `variant="cpu-<language>"` (Vosk is CPU-only, so no
  compute-type dimension). Vosk expects 16 kHz mono PCM and does not decode
  compressed audio, so the sidecar decodes stored segments with PyAV (already a
  faster-whisper dependency) — no new decode dependency.

Setup and env vars are documented in `docs/development.md`
("Second STT provider (Vosk)").

## Corrected dataset export

The Dataset view can export the corrected STT dataset to local JSONL files, in
preparation for Phase 3 normalizer training and Phase 4 STT acoustic
fine-tuning. It only reads the append-only event log and writes new files under
`data/exports/stt-dataset-<timestamp>/`; it never rewrites event history and
never uploads anything.

Decisions:

- The fine-tuning target is `audio -> corrected_transcript` (the human
  reference), not `model transcript -> corrected_transcript`. Model transcripts
  stay useful for benchmarking/error analysis, but the acoustic target is the
  human transcript.
- Records are partitioned by benchmark split (`train_candidate_pool`,
  `validation`, `test_frozen` — frozen test always in its own files) **and** by
  `correction_kind`. Files are named `<split>.<correction_kind>.jsonl`, so the
  acoustic (STT) dataset and the math_transform (normalizer) dataset land in
  distinct files and stay separable.
- L'export lit **toutes** les corrections d'un segment et conserve la dernière
  de **chaque type**, pas uniquement la dernière correction globale. L'outil de
  saisie actuel du Lab (#78) peut produire une chaîne `acoustic` +
  `math_transform` ; réduire le segment à un seul événement supprimerait
  silencieusement la paire acoustique. Dans un même type, la correction la plus
  récente remplace toujours la précédente.
- Untyped legacy corrections (no `correction_kind`) cannot be routed into a
  kind-partitioned dataset, so they are skipped and their count is reported in
  the manifest and UI rather than dropped silently.
- Each record is traceable to its source events: `session_id`, `segment_id`,
  `audio_ref`, resolved absolute `audio_path`, `raw_transcript` and
  `corrected_transcript` (the transform's input/target), `original_stt_output`
  (the raw STT even when a chained correction's own raw text is a later literal
  transcript), `language`, `correction_kind`, `correction_created_at`, and the
  selected base candidate metadata. A `manifest.json` records per-split /
  per-kind counts and the selection. Export proceeds even when no base candidate
  has been selected yet (`selected_candidate` is then null and the UI notes it).

## Décisions sur la notation et l'analyse mathématique

Depuis le 10 juillet 2026, le format canonique du normaliseur est LaTeX, pas
Unicode. Unicode ne peut pas représenter honnêtement intégrales, fractions
structurées, sommes bornées ou matrices. La cible humaine de couche 2 ne se
régénère pas ; le format devait donc être fixé avant la collecte. KaTeX rend du
LaTeX mais n'est ni un format ni une couche du pipeline. L'interrupteur Home
(#105) permet de désactiver le normaliseur dans une application qui ne rend pas
LaTeX. #106 et #107 sont terminés ; voir
`docs/dataset-and-normalization-design.md` §8.

Cette décision concerne la génération de notation. La construction d'un arbre
sémantique à partir de mathématiques parlées ne fait toujours pas partie de la
boucle de travail.

L'analyse mathématique reste au parking. Ne pas l'ajouter tant que la boucle
Typora, le modèle STT persistant, la correction Lab et cent dictées fiables
n'ont pas montré qu'elle bloque réellement le flux. Si elle devient justifiée,
commencer avec une portée étroite :

- variables ;
- arithmétique ;
- fractions ;
- puissances ;
- racines ;
- indices ;
- parenthèses ;
- équations simples.

L'ambiguïté est normale. Une éventuelle interface devra permettre de choisir ou
de corriger facilement la portée de l'analyse.

## Deferred UX proposals

From `docs/ux-review.md`, human decisions recorded:

- **Typographic scale (A)** — wanted, but touches nearly every CSS rule in both
  apps, so it is a merge-conflict magnet. Land it alone, never bundled.
- **Idle DicTeX Home (B)** — decision: **hide empty metrics** until they have a
  value, rather than showing eight `-` cells or seeding from config.
- **Libellé du bouton d'enregistrement (F)** — décision : aligner le bouton sur
  le fonctionnement à bascule avec les libellés anglais **Start / Stop** et le
  même état que `Win+Alt+Space`.
- **Footer actions (C)** and **collapsible Lab data-folder panel (E)** — still
  open, no decision.
- **Unified navigation model (D)** — deliberately deferred. Structural, purely
  aesthetic benefit, and the likeliest way to drift a utility UI toward a
  dashboard. Revisit once both apps stop moving.
- **Theme (G)** — le cahier reste clair ; seule la couleur du bureau extérieur
  suit le thème du lecteur.

## Agent Handoff Guidance

Le protocole exécutable et le routage actuel des modèles vivent dans
`docs/agent-workflow.md`. Utiliser les skills `$dictex-…` dans Codex ou
`/dictex-…` dans Claude Code plutôt que de recopier un long prompt de rôle.

When handing a task to another agent, tell it to read at least:

- `README.md`
- `docs/roadmap.md`
- `docs/agent-workflow.md`
- `CONTRIBUTING.md`
- `docs/product-decisions.md`
- `docs/development.md`
- the GitHub issue it is implementing

Le ticket, les commits et la demande de fusion sont rédigés en français. Le
code, ses commentaires, ses tests et les textes d'interface restent en anglais.

Good tasks for another agent:

- tightly scoped UI improvements;
- diagnostics display;
- settings fields;
- tests/build fixes;
- documentation updates;
- isolated bug fixes.

Risky tasks without human review:

- changing the data model;
- introducing document ownership;
- replacing Electron/Tauri stack;
- adding math parsing too early;
- changing correction semantics;
- changing privacy/storage defaults.

If an implementation conflicts with this document, update the document in the same PR and explain the product reason.

