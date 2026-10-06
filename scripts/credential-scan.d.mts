/**
 * Types for the plain-JS scanner.
 *
 * `scripts/*.mjs` run directly under Node with no build step, so the scanner
 * cannot be TypeScript. This declaration is what lets a test import it and
 * still typecheck.
 */
export interface CredentialShape {
  label: string;
  pattern: RegExp;
}

export declare const CREDENTIAL_SHAPES: CredentialShape[];
export declare const MINIFIED_CREDENTIAL_SHAPES: CredentialShape[];

/**
 * The label of the first credential-shaped value in `text`, or null.
 * `minified` selects the value-shaped set, the only one that survives bundling.
 */
export declare function findCredentialMaterial(
  text: string,
  options?: { minified?: boolean },
): string | null;