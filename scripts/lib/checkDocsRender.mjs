// Pure logic behind scripts/check-docs-render.mjs.
//
// Kept out of the CLI file on purpose: this repository has twice had to move
// logic out of a `scripts/*.mjs` entry point into `scripts/lib/` because a
// test that imported the CLI file ran the CLI. Nothing here touches the
// filesystem except `collectSiteFiles` and `checkSite`, which only read.
//
// Why this exists: `mkdocs build --strict` checks the nav, internal links and
// references, but it has no idea what the page LOOKS like once Material has
// rendered it. A `!!! note` block whose content is not indented four spaces
// builds green and renders an empty box, with the note's own text falling out
// as an ordinary paragraph below it -- that shipped in this repository once.
// The strict build cannot see it because nothing about the markdown was
// invalid; it rendered exactly as written, just not as intended. The four
// checks here all share that shape: each looks for the literal, textual
// symptom left behind in the HTML when a piece of markdown parsed as
// something other than what its author meant, rather than for a markdown
// error the build would already have caught.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The main content region of one rendered page -- between `<article ...>`
 * and its matching `</article>` -- or the whole document if a page has no
 * article wrapper (there is exactly one per page in this theme, but a
 * missing wrapper should not crash the check, only widen it).
 *
 * Restricting every check to this region is what keeps the nav, the search
 * modal markup and the generated table of contents from ever being mistaken
 * for page content: none of those are what an author wrote.
 */
export function extractArticle(html) {
  const open = /<article\b[^>]*>/.exec(html);
  if (!open) return html;
  const start = open.index + open[0].length;
  const end = html.indexOf('</article>', start);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

/**
 * `articleHtml` with every `<pre>...</pre>` block removed.
 *
 * The table, fence and heading checks all look for a piece of markdown
 * syntax leaking into the page as literal text -- a real, correctly
 * highlighted code sample is exactly the one place that kind of text is
 * supposed to appear (a shell comment starting with `#`, a shown-not-run
 * command piped with `|`), so it is cut before any of those checks run.
 */
function withoutCodeBlocks(articleHtml) {
  return articleHtml.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, '');
}

/**
 * `html` with every tag removed, leaving only the text a reader would see.
 *
 * Two things a one-pass `<[^>]+>` gets wrong, and both are why this looks
 * heavier than it should:
 *
 * A quoted attribute may CONTAIN `>`. `<div title="a > b">` stops the naive
 * match early and leaves `">` behind as stray text -- which matters because
 * the callers hunt for markdown syntax that leaked into the page as literal
 * text, and a leftover fragment is exactly what they would report. A checker
 * that invents findings gets ignored, which costs more than it saves. So the
 * pattern below steps over quoted runs.
 *
 * And stripping once is not enough: on `<<script>script>` a single pass over
 * the quote-aware pattern leaves a literal `<script>`. Repeating until the
 * string stops changing removes it. Bounded, so no input can spin here.
 *
 * CodeQL flags the one-pass form (alert 13, incomplete multi-character
 * sanitization). Its stated impact -- HTML element injection -- is NOT
 * reachable in this program: the input is mkdocs' own generated output and
 * the result is printed to a terminal, never into a page. The incompleteness
 * was real regardless, so this is fixed rather than dismissed.
 */
const TAG = /<\/?[a-zA-Z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;

export function textOnly(html) {
  let text = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = text.replace(TAG, '');
    if (next === text) return text;
    text = next;
  }
  return text;
}

const ADMONITION_OPEN = /<div class="admonition[^"]*"[^>]*>/g;
const ADMONITION_TITLE = /^\s*<p class="admonition-title">[\s\S]*?<\/p>/;
const NON_EMPTY_BODY_TAG = /<(p|ul|ol|pre|table)\b[^>]*>([\s\S]*?)<\/\1>/g;

/**
 * The index right after the `<div ...>` that opens at `openEnd - 1`,
 * matched by counting nested `<div>` opens and `</div>` closes rather than
 * stopping at the first `</div>` -- an admonition holding a highlighted code
 * block wraps it in its own `<div class="highlight">`, and that div's close
 * is not the admonition's.
 */
function findMatchingDivClose(html, openEnd) {
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = openEnd;
  let depth = 1;
  let match;
  while ((match = tag.exec(html))) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/** Whether `html` holds a non-empty `<p>`, `<ul>`, `<ol>`, `<pre>` or `<table>`. */
function hasRenderedBody(html) {
  NON_EMPTY_BODY_TAG.lastIndex = 0;
  let match;
  while ((match = NON_EMPTY_BODY_TAG.exec(html))) {
    if (textOnly(match[2]).trim().length > 0) return true;
  }
  return false;
}

/**
 * Every `admonition` div in `articleHtml`, split into the healthy ones and
 * the broken ones.
 *
 * A broken one holds nothing but its title paragraph: un-indent a `!!! note`
 * block's content by one space short of the required four, and Material
 * still emits the div and the title, but the indented block that should have
 * been its body was never recognised as belonging to it, so the div closes
 * immediately and that body reappears as an ordinary paragraph right after
 * it -- outside the box, with no error anywhere in the build.
 */
export function scanAdmonitions(articleHtml) {
  const broken = [];
  let total = 0;
  ADMONITION_OPEN.lastIndex = 0;
  let match;
  while ((match = ADMONITION_OPEN.exec(articleHtml))) {
    total += 1;
    const openEnd = match.index + match[0].length;
    const closeIndex = findMatchingDivClose(articleHtml, openEnd);
    const body =
      closeIndex === -1 ? articleHtml.slice(openEnd) : articleHtml.slice(openEnd, closeIndex);
    const withoutTitle = body.replace(ADMONITION_TITLE, '');
    if (!hasRenderedBody(withoutTitle)) {
      broken.push({
        kind: 'admonition',
        snippet: `${match[0]}${body}`.trim().slice(0, 300),
      });
    }
  }
  return { total, broken };
}

const TABLE_ROW_LIKE = /^[ \t]*\|.*\|[ \t]*$/gm;

/**
 * Every line of `articleHtml`'s text that still looks like a markdown table
 * row -- starting and ending with `|` -- once code samples are set aside.
 *
 * A pipe table needs a separator row (`| --- | --- |`) directly under its
 * header for python-markdown to recognise it as a table at all; drop that
 * row and there is no `<table>` in the output, only the header line surviving
 * as a plain paragraph, pipes and all. A real `<table>` never contains a
 * literal `|` -- its cells are `<td>` elements -- so any line matching this
 * pattern in the rendered text is that leftover header, not a coincidence.
 */
export function findUnrenderedTables(articleHtml) {
  const text = textOnly(withoutCodeBlocks(articleHtml));
  const findings = [];
  TABLE_ROW_LIKE.lastIndex = 0;
  let match;
  while ((match = TABLE_ROW_LIKE.exec(text))) {
    findings.push({ kind: 'table', snippet: match[0].trim() });
  }
  return findings;
}

const STRAY_FENCE = /```/g;

/**
 * Every place a literal triple backtick survives into `articleHtml`'s text,
 * once code samples are set aside.
 *
 * A closed fence's backticks are the delimiter, never the content, so they
 * never appear in a rendered `<pre>`; a page with one, with a fence marker
 * consumed by an earlier or later block instead of the one an author meant it
 * to close, ends with a stray ` ``` ` sitting in an ordinary paragraph
 * instead.
 */
export function findUnclosedFences(articleHtml) {
  const text = textOnly(withoutCodeBlocks(articleHtml));
  const findings = [];
  STRAY_FENCE.lastIndex = 0;
  let match;
  while ((match = STRAY_FENCE.exec(text))) {
    const start = Math.max(0, match.index - 40);
    findings.push({ kind: 'fence', snippet: text.slice(start, match.index + 40).trim() });
  }
  return findings;
}

const BROKEN_HEADING_LIKE = /^[ \t]*#{1,6}[^#\s].*$/gm;

/**
 * Every line of `articleHtml`'s text, once code samples are set aside, that
 * looks like an ATX heading missing its required space (`##Like this`) and
 * was NOT recognised as one.
 *
 * A heading that rendered correctly leaves no `#` behind at all -- the hashes
 * are consumed by the parser, and only the heading's own text ends up inside
 * its `<h1>`-`<h6>` tag. A hash run at the very start of a line in the
 * rendered text is therefore always a heading attempt that fell through to
 * plain text instead, not a real heading -- and not a `#` used mid-sentence,
 * since that never starts a line.
 */
export function findBrokenHeadings(articleHtml) {
  const text = textOnly(withoutCodeBlocks(articleHtml));
  const findings = [];
  BROKEN_HEADING_LIKE.lastIndex = 0;
  let match;
  while ((match = BROKEN_HEADING_LIKE.exec(text))) {
    findings.push({ kind: 'heading', snippet: match[0].trim() });
  }
  return findings;
}

/**
 * Every `.html` file under `root/site`, sorted, depth-first.
 *
 * Returns an empty list rather than throwing when `site/` does not exist yet
 * -- this script only ever reads a build, it never runs one, and a missing
 * directory means `pnpm docs:build` has not happened rather than that the
 * check found nothing to look at.
 */
export function collectSiteFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
    }
  };
  if (existsSync(join(root, 'site'))) walk(join(root, 'site'));
  return files;
}

/**
 * Run every check against one page's HTML.
 *
 * Returns per-check totals (real admonitions, tables, code blocks and
 * headings actually present -- healthy or not) alongside the broken findings,
 * so a clean run can report what it looked at rather than only that nothing
 * was wrong.
 */
export function checkPage(html) {
  const article = extractArticle(html);
  const admonitions = scanAdmonitions(article);
  const tables = findUnrenderedTables(article);
  const fences = findUnclosedFences(article);
  const headings = findBrokenHeadings(article);
  return {
    counts: {
      admonitions: admonitions.total,
      tables: (article.match(/<table\b/g) ?? []).length,
      codeBlocks: (article.match(/<pre\b/g) ?? []).length,
      headings: (article.match(/<h[1-6]\b/g) ?? []).length,
    },
    findings: [...admonitions.broken, ...tables, ...fences, ...headings],
  };
}

/**
 * Check every page under `root/site`.
 *
 * `root/site` must already exist -- this reads a build, `pnpm docs:build`
 * does not run one. Returns the totals summed across every page and every
 * broken finding, each tagged with the file it came from.
 */
export function checkSite(root) {
  const counts = { admonitions: 0, tables: 0, codeBlocks: 0, headings: 0 };
  const failures = [];
  const files = collectSiteFiles(root);
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const { counts: pageCounts, findings } = checkPage(html);
    for (const key of Object.keys(counts)) counts[key] += pageCounts[key];
    for (const finding of findings) failures.push({ file, ...finding });
  }
  return { filesChecked: files.length, counts, failures };
}
