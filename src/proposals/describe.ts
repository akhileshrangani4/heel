/** How a proposal is named in notifications, `heel status` and the approval page. */

/** Pure: "2 new rules", "a hide entry", "a new rule, a hide entry and 2 workdirs". */
export function describeProposal(rules: number, hide: number, workdirs = 0): string {
  const parts: string[] = [];
  if (rules > 0) parts.push(rules === 1 ? "a new rule" : `${rules} new rules`);
  if (hide > 0) parts.push(hide === 1 ? "a hide entry" : `${hide} hide entries`);
  if (workdirs > 0) parts.push(workdirs === 1 ? "a workdir" : `${workdirs} workdirs`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
