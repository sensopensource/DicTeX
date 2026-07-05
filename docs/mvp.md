# MVP

The MVP should prove one thing:

DicTeX can turn spoken input into text that can be inserted into the active app, while preserving local audio and STT logs for future improvement.

## Target User

Initial target:

- the creator using it personally;
- students, researchers, and teachers who write mathematical text;
- French-speaking users first.

## Core Features

- Record short voice segments.
- Transcribe locally.
- Insert the output into the active application.
- Trigger dictation with a global hotkey.
- Auto-paste on Windows.
- Store every audio segment locally.
- Store every STT result locally.

Future MVP layers:

- classify each segment as paragraph, math, or command;
- convert spoken math into LaTeX;
- allow fast correction;
- store correction events locally;
- optionally expose Markdown/LaTeX output for copy, paste, or export.

## Initial Math Scope

The first math scope is not implemented yet. When it starts, it should stay narrow:

- variables;
- basic arithmetic;
- fractions;
- powers;
- roots;
- indices;
- parentheses;
- basic functions;
- simple equations.

Examples:

```text
f de x egal x au carre moins trois x plus deux
```

```latex
f(x) = x^2 - 3x + 2
```

```text
un sur x plus un
```

Ambiguous result candidates:

```latex
\frac{1}{x} + 1
\frac{1}{x + 1}
```

## Out Of Scope

- complete LaTeX authoring;
- full document ownership;
- internal document editor;
- full theorem proving;
- automatic proof checking;
- advanced symbolic computation;
- collaborative editing;
- cloud sync;
- mobile support;
- model fine-tuning in the first version.
