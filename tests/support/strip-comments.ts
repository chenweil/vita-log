/**
 * Remove `//` and block comments from TypeScript source, keeping the contents of
 * string literals — including template literals — intact.
 *
 * Guards that scan source for a route literal have to tell prose from code.
 * `server-auth.ts` explains in a doc comment why `/api/setup` is gone, and that
 * explanation must not fail a check about calling it; meanwhile a backtick in
 * real code (`` fetch(`/api/setup`) ``) is exactly the case a quote-only regex
 * misses. Stripping comments first separates the two: the prose goes, the
 * template literal stays.
 *
 * The scanner tracks quote state so that `//` inside a URL — `'https://…'` —
 * is not mistaken for the start of a comment, which would swallow the rest of
 * the line and could hide a real literal after it.
 */
export function stripComments(source: string): string {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | '`' | null = null;

  while (index < source.length) {
    const character = source[index]!;

    if (quote !== null) {
      // Copy the literal verbatim, honouring the escape that keeps a quote from
      // ending it early. A `//` or `/*` here belongs to the string, not the file.
      if (character === '\\') {
        output += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      output += character;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
      index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}
