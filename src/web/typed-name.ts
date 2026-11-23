/**
 * A name as someone typed it for a new account or person: phones capitalize
 * the first letter and people type spaces, but these names are lowercase
 * with dashes because rules and tools spell them. "Gmail Work" becomes
 * "gmail-work"; anything else still has to pass the name's own check.
 */
export function typedName(typed: string): string {
  return typed.trim().toLowerCase().replace(/\s+/g, "-");
}
