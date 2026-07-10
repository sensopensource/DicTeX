# Composants libres étudiés

Ce document est un inventaire technique, pas une feuille de route. Toute
intégration doit répondre à un blocage observé dans
[la direction actuelle](roadmap.md).

## Reconnaissance vocale

- `faster-whisper` : moteur STT principal et local ;
- Vosk : second fournisseur utilisé dans le banc d'essai ;
- `whisper.cpp` : option éventuelle de distribution ;
- WhisperX : alignement et horodatage si les corrections fines l'exigent ;
- Silero VAD : détection de voix éventuelle.

## Exécution locale de modèles

- Ollama : exécution simple pour une expérience locale ;
- `llama.cpp` : exécution et distribution de bas niveau ;
- bibliothèques Hugging Face et PEFT : expériences seq2seq ou adaptateurs,
  seulement après les portes de données et de mesure.

## Rendu et validation mathématiques

- KaTeX et MathJax : rendu de LaTeX ;
- SymPy et `latex2sympy2` : validation symbolique éventuelle, pas dans le chemin
  critique actuel.

Typora fournit le premier cahier réel. Zettlr reste la solution de repli. TipTap
et CodeMirror ne deviennent pertinents que si un éditeur DicTeX dédié est un
jour justifié par l'usage.

## Interface

- Electron : enveloppe de bureau actuelle ;
- React : interface actuelle ;
- Tauri : migration non prévue.

Le projet ne doit pas assembler ces composants par anticipation. Il garde le
plus petit ensemble qui améliore le flux quotidien et ses mesures.
