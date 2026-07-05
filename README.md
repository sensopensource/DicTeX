# DicTeX

DicTeX is a local-first voice tool for mathematical dictation.

It turns spoken language into text and LaTeX that can be inserted into the active application, while storing correction logs that can later improve the system.

## Core Idea

Mathematical dictation is not only speech-to-text.

Users mix natural language, equations, commands, hesitation, and corrections. DicTeX is designed around that reality:

```text
Voice
-> transcription
-> paragraph/math detection
-> text + LaTeX generation
-> insertion into the active app
-> fast correction
-> correction logs
-> future improvement
```

## Product Loop

```mermaid
flowchart LR
    A[Voice] --> B[Transcription]
    B --> C[Paragraph or math?]
    C --> D[Text + LaTeX]
    D --> E[Insert in active app]
    E --> F[Fast correction]
    F --> G[Correct output]
    F --> H[Correction logs]
    H --> I[Future improvement]
```

## MVP Scope

The first version focuses on a small but useful local workflow:

- local speech-to-text;
- paragraph vs math detection;
- spoken math to LaTeX;
- insertion into the active application;
- fast correction loop;
- local correction logging;
- optional Markdown + LaTeX output.

## Not In The MVP

- cloud sync;
- collaborative editing;
- full computer algebra system;
- production-grade fine-tuning;
- mobile apps;
- multi-user backend.

## Why Correction Logs Matter

Every correction should be stored with context:

```json
{
  "session_id": "session_2026_07_05_001",
  "segment_id": "seg_042",
  "target_app": "obsidian",
  "raw_transcript": "un sur x plus un",
  "predicted_latex": "\\frac{1}{x} + 1",
  "corrected_latex": "\\frac{1}{x + 1}",
  "error_type": "fraction_scope",
  "correction_method": "voice"
}
```

Those logs can later improve:

- parsing rules;
- prompts;
- user preferences;
- evaluation datasets;
- fine-tuned models.

## Francais

DicTeX est un outil local-first de dictee mathematique.

Il transforme la voix en texte et equations LaTeX inserables dans l'application active, tout en enregistrant un journal de corrections utilisable pour ameliorer progressivement le systeme.

Objectif produit :

```text
Dicter des maths, corriger vite, ameliorer le systeme avec chaque correction.
```

## Documentation

- [Vision](docs/vision.md)
- [MVP](docs/mvp.md)
- [Architecture](docs/architecture.md)
- [Correction Loop](docs/correction-loop.md)
- [Open Source Landscape](docs/open-source-landscape.md)
- [Development](docs/development.md)

## Status

Early product definition. No usable implementation yet.
