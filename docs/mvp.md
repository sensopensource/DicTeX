# MVP

The MVP should prove one thing:

DicTeX can turn spoken mathematical thinking into an editable document with a low-friction correction loop.

## Target User

Initial target:

- the creator using it personally;
- students, researchers, and teachers who write mathematical text;
- French-speaking users first.

## Core Features

- Record short voice segments.
- Transcribe locally.
- Classify each segment as paragraph, math, or command.
- Convert spoken math into LaTeX.
- Render the document with math preview.
- Allow fast correction.
- Store every correction event locally.
- Export Markdown with LaTeX.

## Initial Math Scope

The first math scope should stay narrow:

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
- full theorem proving;
- automatic proof checking;
- advanced symbolic computation;
- collaborative editing;
- cloud sync;
- mobile support;
- model fine-tuning in the first version.

