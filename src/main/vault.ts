import * as fs from 'fs';
import * as path from 'path';
import { JiraIssue } from './types';

/**
 * Determine the vault root directory.
 * Checks env var AGENT_SMITH_JIRA_VAULT first, falls back to <dataDir>/jira-context.
 */
export function getVaultRoot(dataDir: string): string {
  return process.env.AGENT_SMITH_JIRA_VAULT || path.join(dataDir, 'jira-context');
}

/**
 * Compute the absolute path for an issue note.
 * Layout: <vaultRoot>/Jira/<PROJECT>/<KEY>.md  (nested by project)
 */
export function issueNotePath(vaultRoot: string, issue: JiraIssue): string {
  const project = issue.key.replace(/-\d+$/, '');
  return path.join(vaultRoot, 'Jira', project, `${issue.key}.md`);
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

  // Acceptance Criteria
  if (issue.acceptanceCriteria) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    lines.push(issue.acceptanceCriteria);
    lines.push('');
  }

  // Description
  if (issue.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(issue.description);
    lines.push('');
  }

  // Developer Tasks
  if (issue.developerTasks) {
    lines.push('## Developer Tasks');
    lines.push('');
    lines.push(issue.developerTasks);
    lines.push('');
  }

  // Release Notes
  if (issue.releaseNotes) {
    lines.push('## Release Notes');
    lines.push('');
    lines.push(issue.releaseNotes);
    lines.push('');
  }

  // Linked Issues (wikilinks)
  if (issue.linkedIssues?.length) {
    lines.push('## Linked Issues');
    lines.push('');
    for (const li of issue.linkedIssues) {
      lines.push(`- ${li.relation} [[${li.key}]]`);
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
