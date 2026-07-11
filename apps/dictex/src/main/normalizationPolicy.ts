import type { NormalizationResult } from "@dictex/shared";
import { expandCommands } from "@dictex/shared/commands";

export type NormalizationLayerEventRecord = {
  [key: string]: string | boolean | string[];
};

export type NormalizationEventState = { disabled: true } | { passthrough: boolean };

export type PreparedNormalization = {
  insertedTranscript: string;
  normalizationApplied: boolean;
  normalizationDiagnostics: string[];
  inputTranscript: string;
  outputTranscript: string;
  eventState: NormalizationEventState;
  layers: NormalizationLayerEventRecord[];
};

/**
 * Apply the normalizer policy for one dictation.
 *
 * When disabled, the callback is never invoked and the raw STT output remains
 * byte-identical. When enabled, command sentinels are expanded before any text
 * reaches the clipboard or event store.
 */
export async function prepareNormalization(
  rawTranscript: string,
  enabled: boolean,
  normalize: () => Promise<NormalizationResult>,
): Promise<PreparedNormalization> {
  if (!enabled) {
    return {
      insertedTranscript: rawTranscript,
      normalizationApplied: false,
      normalizationDiagnostics: [],
      inputTranscript: rawTranscript,
      outputTranscript: rawTranscript,
      eventState: { disabled: true },
      layers: [],
    };
  }

  const normalization = await normalize();
  const insertedTranscript = expandCommands(normalization.output);

  return {
    insertedTranscript,
    normalizationApplied: insertedTranscript !== normalization.input,
    normalizationDiagnostics: normalization.diagnostics,
    inputTranscript: normalization.input,
    outputTranscript: insertedTranscript,
    eventState: { passthrough: insertedTranscript === normalization.input },
    layers: normalization.layers.map((layer) => {
      const input = expandCommands(layer.input);
      const output = expandCommands(layer.output);
      return {
        layer: layer.layer,
        input,
        output,
        applied: output !== input,
        diagnostics: layer.diagnostics,
      };
    }),
  };
}
