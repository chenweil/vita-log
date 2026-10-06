/**
 * Hex encoding for credential and token material.
 *
 * Three call sites need it, and they are the ones that must agree: a credential
 * that encoded its salt one way and its digest another would still round-trip
 * through its own parser, so the mismatch would not surface until a digest
 * stopped matching. One implementation removes the possibility.
 *
 * The output is lowercase and fixed-width, because that is what the credential
 * format's parser accepts.
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Parse hex, or null when the input is not lowercase, even-length hex. */
export function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
