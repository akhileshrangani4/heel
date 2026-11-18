/**
 * Builds the site's docs pages from the repo, so the docs are written once
 * (runs before `next dev` and `next build`):
 *
 * - docs/*.md become pages under /docs. design/ and research/ stay in the repo.
 * - The README's Install, Quick start and What it does sections become /docs.
 * - Each page's H1 becomes its title, and the first paragraph its description.
 * - Links between docs stay relative; links to other repo files go to GitHub.
 * - The logo, favicons and the video are copied into public/.
 *
 * Everything this writes is ignored by git (site/.gitignore).
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(site, "..");
const out = join(site, "content", "docs");
const GITHUB = "https://github.com/akhileshrangani4/heel/blob/main/";

/** The sidebar, in order: [page, file in docs/]. */
const PAGES = [
  ["using-heel", "using-heel.md"],
  ["why", "why.md"],
  ["how-it-works", "how-it-works.md"],
  ["rules", "rules.md"],
  ["approvals", "approvals.md"],
  ["running", "running.md"],
  ["incidents", "incidents.md"],
  ["comparison", "comparison.md"],
  ["releasing", "releasing.md"],
];

/** Page titles by docs file, from each page's H1. */
const TITLES = new Map(
  PAGES.map(([, file]) => {
    const h1 = /^# (.+)$/m.exec(readFileSync(join(repo, "docs", file), "utf8"));
    return [file, h1 ? h1[1].trim() : file];
  }),
);

/** Rewrites links for the site. `from` is the page's directory in the repo. */
function links(markdown, from) {
  // Link text that is just a file name ([docs/running.md](...)) reads as the page's title.
  const named = markdown.replace(
    /\[(?:docs\/)?([a-z-]+\.md)\]\(/g,
    (whole, file) => (TITLES.has(file) ? `[${TITLES.get(file)}](` : whole),
  );
  return named.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const [path, hash] = target.split("#");
    const resolved = relative(repo, join(from, path));
    const anchor = hash ? `#${hash}` : "";
    if (resolved === "README.md") return `](/docs${anchor})`;
    const page = PAGES.find(([, file]) => resolved === `docs/${file}`);
    if (page) return `](/docs/${page[0]}${anchor})`;
    if (resolved.startsWith("assets/")) return `](/${resolved.split("/").pop()})`;
    return `](${GITHUB}${resolved}${anchor})`;
  });
}

/** Front matter from the H1 and first paragraph; the H1 itself is dropped. */
function page(markdown, from, fallbackTitle) {
  let text = markdown.replace(/^\[README\]\([^\n]*\n\n/m, "");
  const h1 = /^# (.+)\n+/m.exec(text);
  const title = h1 ? h1[1].trim() : fallbackTitle;
  if (h1) text = text.slice(0, h1.index) + text.slice(h1.index + h1[0].length);
  const first = text
    .split(/\n{2,}/)
    .find((p) => p.trim() && !/^[#|`!<\-\d[]/.test(p.trim()));
  // The first full sentence, for metadata and the prev/next cards.
  const plain = first
    ? first.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim()
    : "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain);
  const description = sentence ? sentence[0] : "";
  const yaml = (s) => JSON.stringify(s);
  return `---\ntitle: ${yaml(title)}\ndescription: ${yaml(description)}\n---\n\n${links(text.trim(), from)}\n`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [slug, file] of PAGES) {
  const text = readFileSync(join(repo, "docs", file), "utf8");
  writeFileSync(join(out, `${slug}.md`), page(text, join(repo, "docs"), slug));
}

const readme = readFileSync(join(repo, "README.md"), "utf8");
const start = readme.indexOf("## Install");
const end = readme.indexOf("## Docs");
if (start < 0 || end < start) throw new Error("README.md has no ## Install ... ## Docs span");
writeFileSync(
  join(out, "index.md"),
  page(
    `# Get started\n\nInstall heel, start it, connect an account and give an agent its token.\n\n${readme.slice(start, end).trim()}\n`,
    repo,
    "Get started",
  ),
);

writeFileSync(
  join(out, "meta.json"),
  `${JSON.stringify({ title: "heel", pages: ["index", ...PAGES.map(([slug]) => slug)] }, null, 2)}\n`,
);

const pub = join(site, "public");
mkdirSync(pub, { recursive: true });
for (const file of [
  "assets/logo/heel-icon.svg",
  "assets/logo/heel-icon-32.png",
  "assets/logo/heel-icon-180.png",
  "assets/logo/heel-icon-512.png",
  "assets/heel.gif",
  "assets/heel.mp4",
]) {
  copyFileSync(join(repo, file), join(pub, file.split("/").pop()));
}
console.error(`synced ${PAGES.length + 1} docs pages`);
