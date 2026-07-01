/**
 * Convert Jira wiki markup to Markdown.
 *
 * Processing order matters: code blocks are extracted first to protect their
 * content from subsequent conversions, then re-inserted at the end.
 */

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// Placeholder prefix unlikely to appear in real content
const PH = '\x00CODE_BLOCK_';

export function convertWikiToMarkdown(raw: string): string {
  if (!raw) return '';

  // Normalize line endings and clean up non-breaking spaces on blank lines
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/^\xa0$/gm, '');

  // --- 1. Extract and protect code blocks ---
  const codeBlocks: string[] = [];
  text = text.replace(
    /\{code(?::([^}]*))?\}([\s\S]*?)\{code\}/g,
    (_match, lang: string | undefined, body: string) => {
      const idx = codeBlocks.length;
      const fence = lang ? `\`\`\`${lang.trim()}` : '```';
      codeBlocks.push(`${fence}\n${body.trim()}\n\`\`\``);
      return `${PH}${idx}\x00`;
    }
  );

  // --- 2. Extract and protect inline code ---
  const inlineCode: string[] = [];
  text = text.replace(
    /\{\{([^}]+)\}\}/g,
    (_match, code: string) => {
      const idx = codeBlocks.length + inlineCode.length;
      inlineCode.push(`\`${code}\``);
      return `${PH}${idx}\x00`;
    }
  );

  // --- 3. Bullet lists: * item → - item (with nesting) ---
  // Must run BEFORE bold conversion to prevent *item being treated as bold
  // Allow optional leading whitespace before the asterisks
  text = text.replace(/^\s*(\*+)\s+/gm, (_match, stars: string) => {
    const depth = stars.length - 1;
    return '    '.repeat(depth) + '- ';
  });

  // --- 4. Numbered lists: # item → 1. item (with nesting) ---
  // Must run BEFORE heading conversion to prevent # being treated as Markdown heading
  // Allow optional leading whitespace before the hashes
  text = text.replace(/^\s*(#+)\s+/gm, (_match, hashes: string) => {
    const depth = hashes.length - 1;
    return '    '.repeat(depth) + '1. ';
  });

  // --- 5. Headings: h1. text → # text ---
  text = text.replace(/^h([1-6])\.\s+(.*)$/gm, (_match, level: string, content: string) => {
    return '#'.repeat(parseInt(level, 10)) + ' ' + content.trim();
  });

  // --- 6. Bold: *text* → **text** ---
  // Avoid matching list markers (already converted to "- ") or standalone asterisks
  text = text.replace(/(?<!\w)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\w)/g, '**$1**');

  // --- 7. Italic: _text_ → *text* ---
  text = text.replace(/(?<!\w)_([^\s_](?:[^_]*[^\s_])?)_(?!\w)/g, '*$1*');

  // --- 8. Links: [text|url] → [text](url), [url] → <url> ---
  text = text.replace(/\[([^|\]\n]+)\|([^\]\n]+)\]/g, '[$1]($2)');
  text = text.replace(/\[([^\]\n]+)\]/g, (_match, content: string) => {
    // If it looks like a URL, make it a link
    if (/^https?:\/\//.test(content.trim())) {
      return `<${content.trim()}>`;
    }
    // Otherwise pass through (could be a wiki-style reference)
    return `[${content}]`;
  });

  // --- 9. Tables ---
  text = convertTables(text);

  // --- 10. Colour: {color:x}text{color} → just the text ---
  text = text.replace(/\{color:[^}]*\}([\s\S]*?)\{color\}/g, '$1');

  // --- 11. Jira key linkification (on unprotected text only) ---
  text = linkifyJiraKeys(text);

  // --- 12. Re-insert protected code blocks and inline code ---
  const allProtected = [...codeBlocks, ...inlineCode];
  text = text.replace(
    new RegExp(`${escapeRegex(PH)}(\\d+)\x00`, 'g'),
    (_match, idxStr: string) => {
      const idx = parseInt(idxStr, 10);
      return allProtected[idx] ?? _match;
    }
  );

  return text.trim();
}

/**
 * Convert Jira wiki table syntax to Markdown tables.
 * ||header|| rows become | header | with a separator line.
 * |cell| rows become | cell |.
 */
function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inTable = false;
  let headerDone = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Header row: ||col1||col2||
    if (/^\|\|.+\|\|\s*$/.test(trimmed)) {
      const cells = trimmed
        .replace(/^\|\|/, '')
        .replace(/\|\|\s*$/, '')
        .split('||')
        .map((c) => c.trim());
      result.push('| ' + cells.join(' | ') + ' |');
      result.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      inTable = true;
      headerDone = true;
      continue;
    }

    // Data row: |col1|col2|
    if (/^\|.+\|\s*$/.test(trimmed) && !/^\|\|/.test(trimmed)) {
      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim());

      // If we haven't seen a header row yet, synthesize a separator
      if (!headerDone && !inTable) {
        result.push('| ' + cells.join(' | ') + ' |');
        result.push('| ' + cells.map(() => '---').join(' | ') + ' |');
        inTable = true;
        headerDone = true;
        continue;
      }

      result.push('| ' + cells.join(' | ') + ' |');
      inTable = true;
      continue;
    }

    // Not a table row — reset table state
    if (inTable) {
      inTable = false;
      headerDone = false;
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Wrap Jira issue keys (e.g. PROJ-123) as Markdown links [KEY](jira://KEY).
 * Skips keys inside:
 * - Protected placeholders (already handled)
 * - Existing Markdown links [...](...) 
 * - URLs (http://...)
 */
function linkifyJiraKeys(text: string): string {
  // Split on markdown links and URLs to avoid linkifying inside them
  const parts = text.split(/(\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/g);

  return parts.map((part, i) => {
    // Odd indices are captured groups (links/URLs) — leave them alone
    if (i % 2 === 1) return part;
    // Even indices are normal text — linkify keys
    return part.replace(JIRA_KEY_RE, '[$1](jira://$1)');
  }).join('');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
