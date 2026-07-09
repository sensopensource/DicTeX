export function normalizeForScoring(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function calculateEditDistance<T>(left: T[], right: T[]): number {
  const previousRow = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const currentRow = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    currentRow[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      currentRow[rightIndex] = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previousRow[rightIndex] = currentRow[rightIndex];
    }
  }

  return previousRow[right.length];
}

export function calculateCharacterErrorRate(candidateTranscript: string, referenceTranscript: string): number {
  const candidate = normalizeForScoring(candidateTranscript);
  const reference = normalizeForScoring(referenceTranscript);

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate.split(""), reference.split("")) / reference.length;
}

export function calculateWordErrorRate(candidateTranscript: string, referenceTranscript: string): number {
  const candidate = tokenizeWords(candidateTranscript);
  const reference = tokenizeWords(referenceTranscript);

  if (reference.length === 0) {
    return candidate.length === 0 ? 0 : 1;
  }

  return calculateEditDistance(candidate, reference) / reference.length;
}

function tokenizeWords(value: string): string[] {
  return normalizeForScoring(value)
    .split(/\s+/)
    .filter((word) => word.length > 0);
}
