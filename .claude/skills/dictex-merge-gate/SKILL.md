---
name: dictex-merge-gate
description: Vérifier mécaniquement qu'une PR DicTeX marquée ready peut être fusionnée, puis répondre GO ou NO-GO sans mutation.
argument-hint: "[numero-pr]"
disable-model-invocation: true
---

Lire intégralement `../../../.agents/skills/dictex-merge-gate/SKILL.md`, puis appliquer ce contrat canonique.

Utiliser comme entrée : `$ARGUMENTS`. Ne modifier ni fichier, ni label, ni PR et ne jamais fusionner.
