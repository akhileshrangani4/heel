/** How a proposal is named in notifications, `heel status` and the approval page. */

/** Pure: "2 new rules", "a hide entry", "a new rule and 2 hide entries". */
export function describeProposal(rules: number, hide: number): string {
  const parts: string[] = [];
  if (rules > 0) parts.push(rules === 1 ? "a new rule" : `${rules} new rules`);
  if (hide > 0) parts.push(hide === 1 ? "a hide entry" : `${hide} hide entries`);
  return parts.join(" and ");
}
