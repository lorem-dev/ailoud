import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkPage,
  textOnly,
  checkSite,
  collectSiteFiles,
  extractArticle,
  findBrokenHeadings,
  findUnclosedFences,
  findUnrenderedTables,
  scanAdmonitions,
} from './checkDocsRender.mjs';

const ARTICLE = (inner) =>
  `<html><body><article class="md-content__inner md-typeset">${inner}</article></body></html>`;

describe('extractArticle', () => {
  it('returns the region between the article tags', () => {
    expect(extractArticle(ARTICLE('<p>hello</p>'))).toBe('<p>hello</p>');
  });

  it('falls back to the whole document when there is no article wrapper', () => {
    expect(extractArticle('<p>no wrapper here</p>')).toBe('<p>no wrapper here</p>');
  });
});

describe('scanAdmonitions', () => {
  it('counts a healthy admonition as healthy, not broken', () => {
    // The real shape Material renders for `!!! note` with its content
    // correctly indented four spaces.
    const html =
      '<div class="admonition note">\n' +
      '<p class="admonition-title">Note</p>\n' +
      '<p>Comments do not survive an edit.</p>\n' +
      '</div>';
    const { total, broken } = scanAdmonitions(html);
    expect(total).toBe(1);
    expect(broken).toEqual([]);
  });

  it('flags an admonition holding nothing but its title', () => {
    // The real shape Material renders once the content is not indented: the
    // div closes right after the title, and the body that should have been
    // inside it becomes a plain sibling paragraph. Reproduced by literally
    // un-indenting docs/mcp.md's "!!! note" block, rebuilding, and reading
    // site/mcp/index.html -- see the task report for that run's output.
    const html =
      '<div class="admonition note">\n' +
      '<p class="admonition-title">Note</p>\n' +
      '</div>\n' +
      '<p>Comments do not survive an edit.</p>';
    const { total, broken } = scanAdmonitions(html);
    expect(total).toBe(1);
    expect(broken).toHaveLength(1);
    expect(broken[0].kind).toBe('admonition');
    expect(broken[0].snippet).toContain('admonition-title');
  });

  it('does not stop at a nested div, such as a highlighted code block', () => {
    const html =
      '<div class="admonition tip">\n' +
      '<p class="admonition-title">Tip</p>\n' +
      '<div class="highlight"><pre><code>ailoud audio ls</code></pre></div>\n' +
      '</div>';
    const { broken } = scanAdmonitions(html);
    expect(broken).toEqual([]);
  });

  it('treats a title-only admonition with only whitespace after it as broken', () => {
    const html =
      '<div class="admonition warning">\n<p class="admonition-title">Warning</p>\n   \n</div>';
    expect(scanAdmonitions(html).broken).toHaveLength(1);
  });

  it('finds nothing in a page with no admonition at all', () => {
    expect(scanAdmonitions('<p>Nothing to see here.</p>')).toEqual({ total: 0, broken: [] });
  });
});

describe('findUnrenderedTables', () => {
  it('finds nothing when a table rendered as a real <table>', () => {
    const html =
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
    expect(findUnrenderedTables(html)).toEqual([]);
  });

  it('flags a header row left as literal text for want of a separator row', () => {
    // The real shape when a pipe table's "---|---" row is missing: no
    // <table> is produced at all, and the header line survives as a plain
    // paragraph, pipes included.
    const html = '<p>| A | B |\nNot a separator, just text</p>';
    const findings = findUnrenderedTables(html);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ kind: 'table', snippet: '| A | B |' });
  });

  it('ignores a shell pipe shown inside a code sample', () => {
    const html =
      "<pre><code>ailoud audio show ID001 --format json | jq '.segments[0]'</code></pre>";
    expect(findUnrenderedTables(html)).toEqual([]);
  });
});

describe('findUnclosedFences', () => {
  it('finds nothing when every fence closed where its author meant it to', () => {
    const html = '<pre><code>ailoud audio ls</code></pre><p>Some prose after it.</p>';
    expect(findUnclosedFences(html)).toEqual([]);
  });

  it('flags a stray triple backtick left in the rendered text', () => {
    // The real shape when an outer fence closes early (a line inside it
    // happened to match the same three-backtick marker): the rest of the
    // intended example becomes a paragraph, and the backticks meant to open
    // the next block survive as literal text instead of starting a <pre>.
    const html =
      '<p>this line was meant to stay in the example\n```\nand this opens another one</p>';
    const findings = findUnclosedFences(html);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('fence');
    expect(findings[0].snippet).toContain('```');
  });
});

describe('findBrokenHeadings', () => {
  it('finds nothing for a heading that rendered as a real <h2>, hashes and all consumed', () => {
    const html =
      '<h2 id="recordings">Recordings<a class="headerlink" href="#recordings">&para;</a></h2>';
    expect(findBrokenHeadings(html)).toEqual([]);
  });

  it('flags a hash run at the start of a line that never became a heading', () => {
    const html = '<p>##Glued, no space, and never turned into a heading</p>';
    const findings = findBrokenHeadings(html);
    expect(findings).toHaveLength(1);
    expect(findings[0].snippet.startsWith('##Glued')).toBe(true);
  });

  it('ignores a "#" used mid-sentence, since a real heading never starts mid-line', () => {
    const html = '<p>Prose with a #hashtag inline, not a heading.</p>';
    expect(findBrokenHeadings(html)).toEqual([]);
  });
});

describe('checkPage', () => {
  it('reports totals for a fully healthy page', () => {
    const html = ARTICLE(
      '<h2 id="a">A<a href="#a">&para;</a></h2>' +
        '<table><thead><tr><th>X</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' +
        '<pre><code>ailoud audio ls</code></pre>' +
        '<div class="admonition note"><p class="admonition-title">Note</p><p>Body.</p></div>',
    );
    const { counts, findings } = checkPage(html);
    expect(counts).toEqual({ admonitions: 1, tables: 1, codeBlocks: 1, headings: 1 });
    expect(findings).toEqual([]);
  });

  it('collects findings from every check on the one page', () => {
    const html = ARTICLE(
      '<div class="admonition note"><p class="admonition-title">Note</p></div><p>Fell out.</p>',
    );
    const { findings } = checkPage(html);
    expect(findings.map((f) => f.kind)).toEqual(['admonition']);
  });
});

describe('collectSiteFiles and checkSite', () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSite(files) {
    const root = mkdtempSync(join(tmpdir(), 'ailoud-check-docs-render-lib-'));
    made.push(root);
    for (const [relativePath, content] of Object.entries(files)) {
      const full = join(root, 'site', relativePath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  it('collects every .html file under site/, sorted', () => {
    const root = makeSite({
      'index.html': '<html></html>',
      'usage/recordings/index.html': '<html></html>',
      'usage/notes.txt': 'not html',
    });
    const files = collectSiteFiles(root).map((f) => f.slice(root.length + 1));
    expect(files).toEqual(['site/index.html', 'site/usage/recordings/index.html']);
  });

  it('reports zero failures across a clean site', () => {
    const root = makeSite({
      'index.html': ARTICLE('<h1 id="home">Home<a href="#home">&para;</a></h1>'),
      'mcp/index.html': ARTICLE(
        '<div class="admonition note"><p class="admonition-title">Note</p><p>Fine.</p></div>',
      ),
    });
    const result = checkSite(root);
    expect(result.filesChecked).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.counts.admonitions).toBe(1);
  });

  it('names the offending file for a broken admonition', () => {
    const root = makeSite({
      'index.html': ARTICLE('<p>Fine.</p>'),
      'mcp/index.html': ARTICLE(
        '<div class="admonition note"><p class="admonition-title">Note</p></div><p>Fell out.</p>',
      ),
    });
    const result = checkSite(root);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file.endsWith(join('mcp', 'index.html'))).toBe(true);
    expect(result.failures[0].kind).toBe('admonition');
  });
});

describe('textOnly', () => {
  it('removes a tag whose quoted attribute contains ">"', () => {
    // A one-pass `<[^>]+>` stops at the first `>` and leaves `">` behind.
    // These checks hunt for markdown that leaked into the page as literal
    // text, so a leftover fragment is exactly what they would report.
    expect(textOnly('<div a=">">t')).toBe('t');
    expect(textOnly('<span title="a > b">seen</span>')).toBe('seen');
    expect(textOnly('<a href="x?y>z">link</a>')).toBe('link');
  });

  it('leaves no tag behind on a doubled opening bracket', () => {
    // One pass over the quote-aware pattern leaves a literal `<script>`;
    // repeating until the string stops changing removes it. This is the shape
    // CodeQL flagged as incomplete sanitization.
    expect(textOnly('<<script>script>alert')).toBe('alert');
  });

  it('leaves ordinary comparisons alone', () => {
    expect(textOnly('a < b and c > d')).toBe('a < b and c > d');
  });
});
