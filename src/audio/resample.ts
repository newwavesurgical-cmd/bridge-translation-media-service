export function resampleLinearPcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    return new Int16Array(input);
  }
  if (input.length === 0) {
    return new Int16Array();
  }

  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i / ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const fraction = sourceIndex - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right = input[rightIndex] ?? left;
    output[i] = Math.round(left + (right - left) * fraction);
  }

  return output;
}
