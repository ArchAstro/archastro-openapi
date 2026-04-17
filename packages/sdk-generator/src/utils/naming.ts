/**
 * Convert "some_thing" or "SomeThing" to "someThing".
 */
export function camelCase(s: string): string {
  return s
    .replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/**
 * Convert "someThing" or "some_thing" to "PascalCase".
 */
export function pascalCase(s: string): string {
  const cc = camelCase(s);
  return cc.charAt(0).toUpperCase() + cc.slice(1);
}

/**
 * Convert "someThing" or "SomeThing" to "some_thing".
 */
export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/**
 * Singularize a simple English plural: "teams" → "team", "members" → "member".
 * Only handles common suffixes; doesn't attempt irregular forms.
 */
export function singularize(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes"))
    return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/**
 * Pluralize a simple English word: "team" → "teams".
 */
export function pluralize(s: string): string {
  if (s.endsWith("s") || s.endsWith("x") || s.endsWith("z")) return s + "es";
  if (s.endsWith("y") && !/[aeiou]y$/i.test(s))
    return s.slice(0, -1) + "ies";
  return s + "s";
}
