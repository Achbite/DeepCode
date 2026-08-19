export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer.');
  }
  if (utf8ByteLength(value) <= maximumBytes) return value;

  let prefixLength = 0;
  let byteLength = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    const scalarBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (byteLength + scalarBytes > maximumBytes) break;
    byteLength += scalarBytes;
    prefixLength += scalar.length;
  }
  return value.slice(0, prefixLength);
}
