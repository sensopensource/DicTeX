# Correction Loop

Correction is a core part of DicTeX.

The system should not only edit the visible document. It should record correction events that can later improve rules, prompts, preferences, and models.

## Correction Event

Example:

```json
{
  "event_type": "correction",
  "timestamp": "2026-07-05T12:00:00Z",
  "document_id": "doc_001",
  "segment_id": "seg_042",
  "audio_ref": "audio/seg_042.wav",
  "raw_transcript": "un sur x plus un",
  "normalized_transcript": "un sur x plus un",
  "predicted_latex": "\\frac{1}{x} + 1",
  "corrected_latex": "\\frac{1}{x + 1}",
  "correction_method": "voice",
  "error_type": "fraction_scope"
}
```

## Correction Methods

MVP priority:

- keyboard edit;
- select-and-replace;
- choose between alternatives.

Later:

- voice correction;
- personalized commands;
- automatic preference learning.

## Improvement Levels

Corrections should not immediately mutate the global system.

Use separate levels:

- local document correction;
- user preference;
- rule improvement;
- prompt improvement;
- evaluation example;
- fine-tuning example.

## Dataset Export

Correction events should be exportable as JSONL:

```jsonl
{"input":"un sur x plus un","wrong":"\\frac{1}{x} + 1","correct":"\\frac{1}{x + 1}","error_type":"fraction_scope"}
```

