# Vision

DicTeX is a local-first tool for writing mathematical documents with voice.

The goal is to let users speak naturally while mixing paragraphs, equations, and editing commands. The system should produce a structured document that can be corrected quickly and exported as Markdown or LaTeX.

## Problem

General speech-to-text tools are not good enough for mathematical reasoning.

They usually fail at:

- distinguishing prose from equations;
- preserving mathematical structure;
- handling ambiguity in fractions, powers, indices, and parentheses;
- making corrections fast enough to preserve the user's flow;
- learning from repeated corrections.

## Product Thesis

The core product is not just speech-to-LaTeX.

The core product is:

```text
voice -> structured document -> fast correction -> reusable improvement data
```

DicTeX should make mathematical dictation practical by treating correction as a first-class part of the system.

## Principles

- Local-first by default.
- French-first spoken input for the initial product.
- English-first public documentation for open source discoverability.
- Correction speed matters as much as model accuracy.
- Store structured correction data from day one.
- Fine-tuning comes later, after enough clean correction data exists.

