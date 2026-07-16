import * as fs from 'fs';
import * as path from 'path';
import { JiraIssue, JiraLinkedIssue } from './types';
import { getJiraVaultPath } from './settings';

/**
 * Determine the vault root directory.
 * Reads from settings.json (single source of truth).
 */
export function getVaultRoot(dataDir: string): string {
  return getJiraVaultPath(dataDir);
}

/**
 * Compute the absolute path for an issue note.
 * Layout: <vaultRoot>/<PROJECT>/<KEY>.md  (nested by project)
 */
export function issueNotePath(vaultRoot: string, issue: JiraIssue): string {
  const project = issue.key.replace(/-\d+$/, '');
  return path.join(vaultRoot, project, `${issue.key}.md`);
}

/**
 * Write a single issue as a Markdown note with YAML frontmatter and wikilinks.
 * Uses atomic write (tmp + rename) so partial files are never read by the agent.
 */
export function writeIssueNote(
  vaultRoot: string,
  issue: JiraIssue,
  filteredCount = 0
): void {
  const notePath = issueNotePath(vaultRoot, issue);
  const dir = path.dirname(notePath);
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`key: ${issue.key}`);
  lines.push(`summary: "${escapeFrontmatter(issue.summary)}"`);
  if (issue.status) lines.push(`status: ${issue.status}`);
  if (issue.priority) lines.push(`priority: ${issue.priority}`);
  if (issue.issueType) lines.push(`issueType: ${issue.issueType}`);
  if (issue.assignee) lines.push(`assignee: ${issue.assignee}`);
  if (issue.reporter) lines.push(`reporter: ${issue.reporter}`);
  if (issue.labels?.length) lines.push(`labels: [${issue.labels.join(', ')}]`);
  if (issue.fixVersions?.length) lines.push(`fixVersions: [${issue.fixVersions.join(', ')}]`);
  if (issue.components?.length) lines.push(`components: [${issue.components.join(', ')}]`);
  if (issue.parentKey) lines.push(`parent: "[[${issue.parentKey}]]"`);
  lines.push('---');
  lines.push('');

  // Summary
  lines.push(`# ${issue.key} — ${issue.summary}`);
  lines.push('');

  // Description (already Markdown)
  if (issue.description) {
    lines.push(issue.description);
    lines.push('');
  }

  // Linked Issues (wikilinks)
  if (issue.linkedIssues?.length) {
    lines.push('## Linked Issues');
    lines.push('');
    for (const li of issue.linkedIssues) {
      lines.push(`- ${li.relation} [[${li.key}]] ${li.summary}`);
    }
    if (filteredCount > 0) {
      lines.push(`- *(${filteredCount} linked issues filtered by whitelist)*`);
    }
    lines.push('');
  }

  const content = lines.join('\n');

  // Atomic write: tmp file + rename
  const tmpPath = notePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, notePath);
}

function escapeFrontmatter(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * Compute the vault path for a Jira key (without needing a full JiraIssue).
 */
export function issueNotePathForKey(vaultRoot: string, key: string): string {
  const project = key.replace(/-\d+$/, '');
  return path.join(vaultRoot, project, `${key}.md`);
}

/**
 * Read a Jira issue from the vault.
 * Returns null if the file doesn't exist or the key is invalid.
 */
export function readFromVault(vaultRoot: string, key: string): JiraIssue | null {
  if (!JIRA_KEY_PATTERN.test(key)) return null;

  const notePath = issueNotePathForKey(vaultRoot, key);
  if (!fs.existsSync(notePath)) return null;

  try {
    const content = fs.readFileSync(notePath, 'utf-8');
    return parseVaultNote(key, content);
  } catch {
    return null;
  }
}

/**
 * Parse a vault Markdown note back into a JiraIssue.
 */
function parseVaultNote(key: string, content: string): JiraIssue | null {
  // Split frontmatter and body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  // Parse YAML frontmatter (simple key: value parsing)
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const eqIdx = line.indexOf(':');
    if (eqIdx < 0) continue;
    const k = line.slice(0, eqIdx).trim();
    let v = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    fm[k] = v;
  }

  // Parse arrays from frontmatter: [item1, item2]
  const parseArray = (val: string | undefined): string[] => {
    if (!val) return [];
    const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  };

  // Split body into description and linked issues
  const linkedSplit = body.split(/^## Linked Issues\s*$/m);
  const descriptionRaw = linkedSplit[0] ?? '';
  const linkedSection = linkedSplit[1] ?? '';

  // Remove the "# KEY — Summary" heading from description body
  const description = descriptionRaw
    .replace(/^# .+\n\n?/, '')
    .trim();

  // Parse linked issues from "- relation [[KEY]] summary" lines
  const linkedIssues: JiraLinkedIssue[] = [];
  const linkRe = /^- (.+?) \[\[([A-Z][A-Z0-9]+-\d+)\]\]\s*(.*)$/gm;
  let linkMatch;
  while ((linkMatch = linkRe.exec(linkedSection)) !== null) {
    linkedIssues.push({
      relation: linkMatch[1].trim(),
      key: linkMatch[2],
      summary: linkMatch[3].trim(),
    });
  }

  // Extract parent from frontmatter wikilink
  let parentKey: string | null = null;
  if (fm.parent) {
    const parentMatch = fm.parent.match(/\[\[([A-Z][A-Z0-9]+-\d+)\]\]/);
    if (parentMatch) parentKey = parentMatch[1];
  }

  return {
    __schemaVersion: 3,
    key: fm.key ?? key,
    summary: fm.summary ?? '',
    description,
    status: fm.status ?? '',
    priority: fm.priority ?? '',
    issueType: fm.issueType ?? '',
    assignee: fm.assignee ?? null,
    reporter: fm.reporter ?? null,
    labels: parseArray(fm.labels),
    fixVersions: parseArray(fm.fixVersions),
    components: parseArray(fm.components),
    parentKey,
    linkedIssues,
  };
}
