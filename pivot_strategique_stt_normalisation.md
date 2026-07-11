# 🔄 Pivot Stratégique : Découplage STT et Normalisation Mathématique

> **Archive stratégique encore valide sur le découplage, mais plus sur l'ordre
> immédiat ni l'emplacement des interfaces.** Les couches 1 et 2, les corrections
> typées et la séparation DicTeX/Lab sont maintenant implémentées. La notation
> cible est devenue le LaTeX canonique, pas l'Unicode. Consulter
> `docs/roadmap.md` pour la suite et
> `docs/dataset-and-normalization-design.md` pour les invariants de données.

## Résumé (TL;DR)
Le projet change de priorité de développement. Jusqu'à présent, l'idée était de fine-tuner directement le modèle STT (Whisper ou autre) pour qu'il sorte du texte mathématique propre. Nous allons plutôt **découpler le pipeline en deux**.

1. **Priorité 1 :** Construire un pipeline de normalisation texte-vers-texte pour transformer les sorties littérales en notation LaTeX canonique. C'est la vraie valeur ajoutée.
2. **Priorité 2 :** Utiliser les données récoltées pour fine-tuner le modèle STT (peu importe qu'il s'agisse de Whisper ou d'un autre modèle évalué entre-temps) *uniquement* sur les erreurs purement acoustiques liées à ma voix/mon micro.

---

## Architecture Cible (Diagramme)

```mermaid
graph TD
    %% Inputs
    A[🎙️ Audio Input] --> B[🧠 Modèle STT - Whisper / Autre]
    
    %% Main Flow
    B -->|Texte Brut| C[🔄 Pipeline de Normalisation]
    
    subgraph Pipeline de Normalisation
        C --> D[Couche 1: Dictionnaire Perso]
        D --> E[Couche 2: Règles Regex]
        E --> F[Couche 3: Modèle résiduel texte-vers-texte]
    end
    
    F --> G[🧮 Sortie Markdown + LaTeX]
    G --> N[📓 Cahier externe, Typora d'abord]
    
    %% Feedback Loop / Data Collection
    N -.-> H{❌ Correction nécessaire ?}
    H -->|Oui| I[📝 Correction dans le cahier<br/>qualification dans le Lab]
    
    %% Data Splitting
    I -->|Tag: acoustic| J[(📦 Dataset STT)]
    I -->|Tag: math_transform| K[(📦 Dataset Normaliseur)]
    
    %% Future Training Loops
    J -.->|Phase 4: Fine-tune Acoustique| B
    K -.->|Phase 3: Fine-tune Texte| F
    
    %% Styling
    classDef stt fill:#f9f,stroke:#333,stroke-width:2px;
    classDef norm fill:#bbf,stroke:#333,stroke-width:1px;
    classDef data fill:#bfb,stroke:#333,stroke-width:2px;
    class B stt;
    class C,D,E,F norm;
    class J,K data;
```

---

## Le problème tel qu'il est vraiment

*Observation :* Le modèle STT actuel fait des erreurs. Certaines sont indéniablement liées à ma voix, à mon débit, ou à mon micro. 
*Cependant*, quand je dicte "x au carré plus deux x", le modèle écrit souvent exactement ça. Ce n'est pas une erreur de reconnaissance, c'est la transcription fidèle de la parole.

**Fine-tuner un modèle acoustique pour qu'il comprenne que "au carré" doit devenir "²" est une erreur d'approche** : on mélangerait un problème d'acoustique et un problème de traduction sémantique. La nouvelle vision consiste à séparer ces deux problèmes pour les résoudre chacun avec le bon outil.

### Les 3 couches de normalisation (Priorité 1)

1. **Couche 1 (Dictionnaire) :** Remplacement de sous-chaînes en dur (ex: "dic tex" -> "DicTeX"). Zéro ML, résultat déterministe.
2. **Couche 2 (règles regex) :** motifs prudents de verbalisation mathématique (ex. « x au carré » → `$x^{2}$`).
3. **Couche 3 (modèle normaliseur) :** un petit modèle seq2seq pour le résidu que les règles ne peuvent pas composer ou désambiguïser.

*Note : Une fois ce pipeline en place, si le modèle STT de base fait trop d'erreurs sur ma voix, nous lancerons un fine-tuning acoustique (ex: LoRA) pour le résoudre spécifiquement en Phase 4.*

---

## Ce qui CHANGE dans le codebase

### Redéfinition de la donnée collectée (PRIORITÉ MAXIMALE)
Pour pouvoir fine-tuner *deux* modèles différents (le normaliseur texte ET le STT acoustique), nous devons absolument **typer** la nature de nos corrections. Sans ce tag, les données sont inutilisables.

**Ajout imminent du type `CorrectionKind` :**

```typescript
type CorrectionKind = 
  | "acoustic"          // Le STT a mal entendu (ex: "égalé" -> "égal") -> SERVIRA POUR LA PHASE 4
  | "math_transform"    // Texte parlé -> LaTeX (ex: "x au carré" -> "$x^{2}$") -> SERVIRA POUR LA PHASE 3
  | "normalization"     // Nettoyage (ex: "euh donc on a" -> "on a")
  | "rephrasing";       // Reformulation libre de l'utilisateur
```

Le système de split (`train_candidate_pool`, `test_frozen`) est gardé tel quel, mais servira de base de données pour deux objectifs distincts selon ce tag.

### Apparition d'un nouveau composant
Un nouveau module (Normaliseur) va faire son apparition pour chaîner les Couches 1, 2 et 3 et transformer le texte *avant* de l'envoyer à l'interface de rendu.

---

## Ce qui NE CHANGE PAS (Fondations solides)

L'infrastructure existante est exactement ce dont ce découplage a besoin. Rien n'est jeté :

- ✅ **Le moteur d'enregistrement audio** (Record/Stop/Transcribe).
- ✅ **Le principe de correction typée**. Son interface vit maintenant dans DicTeX Lab ; la correction visible immédiate se fait d'abord dans le cahier externe.
- ✅ **Le système de Benchmark**. Il sera étendu pour évaluer non seulement le CER du STT, mais aussi la précision du normaliseur.
- ✅ **Le système de Split** (`train`, `val`, `test`). C'est avec ça qu'on évaluera nos futurs modèles.
- ✅ **La gestion de l'historique et des segments audio** (crucial pour le futur fine-tuning acoustique).

---

## Pourquoi cet ordre est logique pour un outil "Single-User"

1. **Isolation des problèmes :** Si je fine-tune le STT maintenant, je vais mélanger des exemples acoustiques et des exemples mathématiques. En créant le normaliseur d'abord, j'isole les "vraies" erreurs du STT (les tags `acoustic`).
2. **Rapidité de résultat :** Un dictionnaire + des règles regex peuvent couvrir 60% de mes besoins mathématiques en 2 heures de code. Un fine-tuning STT demande des jours de préparation et de GPU.
3. **Indépendance au modèle STT :** Ce pipeline fonctionnera pareil si je décide de passer de Whisper à un autre modèle STT demain.

---

## État de ce phasage historique

- [x] **Phase 1 : donnée typée** — corrections `acoustic` et `math_transform`, désormais produites dans le Lab.
- [x] **Phase 2 : normaliseur déterministe** — dictionnaire, commandes et regex produisant du LaTeX canonique.
- [ ] **Phase 3 : Le Normaliseur ML (Couche 3)**
  - Différée jusqu'à une référence reproductible, un corpus propre et un résidu clairement mesuré.
- [ ] **Phase 4 : Le Fine-Tuning STT (Le retour du modèle vocal)**
  - Différée après la comparaison des variantes de `initial_prompt`, un volume acoustique minimal et la preuve que les erreurs restantes sont réellement acoustiques.

Le cahier Typora, l'interrupteur du normaliseur, Start/Stop, le moteur STT
persistant, les blocs mathématiques et la validation du chemin Lab précèdent ces
deux phases. Leur ordre exact se trouve dans `docs/roadmap.md`.
