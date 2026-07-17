/** Which completed-dictation variant the HUD is currently showing. */
export type OverlayPreviewVariant = "inserted" | "raw";

/** Keep a long-preview count attached to the variant it actually describes. */
export function formatOverlayPreviewSummary(characters: number, variant: OverlayPreviewVariant): string {
  return variant === "raw" ? `${characters} raw characters` : `${characters} characters inserted`;
}
