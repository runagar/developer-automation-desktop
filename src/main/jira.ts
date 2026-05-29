import * as fs from 'fs';
import { JiraIssue } from './types';

const ENV_PATH = '/home/rulu/mcp_servers_distributable_linux/.env';

let cachedPat: string | null = null;
let cachedBaseUrl: string | null = null;

function loadCredentials(): { pat: string; baseUrl: string } {
  if (cachedPat && cachedBaseUrl) {
    return { pat: cachedPat, baseUrl: cachedBaseUrl };
  }

  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const env: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }

  const pat = env['ATLASSIAN_PAT'];
  const baseUrl = env['ATLASSIAN_BASE_URL']?.replace(/\/$/, '');

  if (!pat || !baseUrl) {
    throw new Error('Missing ATLASSIAN_PAT or ATLASSIAN_BASE_URL in .env');
  }

  cachedPat = pat;
  cachedBaseUrl = baseUrl;
  return { pat, baseUrl };
}

function isSectionHeader(line: string): boolean {
  const t = line.trim();
  if (/^h[1-6]\.\s/.test(t)) return true;
  // Bold wiki markup: *Developer Tasks* or *Developer Tasks*:
  if (/^\*[^*\n]+\*:?\s*$/.test(t)) return true;
  // Capitalised label ending with colon: "Release notes:" "Developer tasks:"
  if (/^[A-Z][^\n]{0,80}:\s*$/.test(t)) return true;
  return false;
}

type ParsedSections = {
  description: string;
  acceptanceCriteria: string;
  releaseNotes: string;
  developerTasks: string;
};

function parseDescription(raw: string): ParsedSections {
  if (!raw) return { description: '', acceptanceCriteria: '', releaseNotes: '', developerTasks: '' };

  const lines = raw.split('\n');

  // Locate all section boundaries
  const boundaries: Array<{ idx: number; header: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) {
      boundaries.push({ idx: i, header: lines[i].trim() });
    }
  }

  // Extract text between boundary[n] (exclusive) and boundary[n+1] (exclusive)
  function extractContent(startIdx: number, endIdx: number): string {
    return lines
      .slice(startIdx, endIdx)
      .map((l) => l.trimStart())
      .join('\n')
      .trim();
  }

  const description = boundaries.length > 0
    ? extractContent(0, boundaries[0].idx)
    : raw.trim();

  let acceptanceCriteria = '';
  let releaseNotes = '';
  const otherSections: string[] = [];

  for (let bi = 0; bi < boundaries.length; bi++) {
    const { header } = boundaries[bi];
    const contentStart = boundaries[bi].idx + 1;
    const contentEnd = bi + 1 < boundaries.length ? boundaries[bi + 1].idx : lines.length;
    const content = extractContent(contentStart, contentEnd);

    if (/acceptance criteri/i.test(header)) {
      acceptanceCriteria = content;
    } else if (/release notes?/i.test(header)) {
      releaseNotes = content;
    } else {
      // Bucket all other sections (e.g. Developer tasks, Module:, etc.) into developerTasks
      if (content) otherSections.push(content);
    }
  }

  return {
    description,
    acceptanceCriteria,
    releaseNotes,
    developerTasks: otherSections.join('\n\n'),
  };
}

export async function fetchJiraIssue(key: string): Promise<JiraIssue> {
  const { pat, baseUrl } = loadCredentials();
  const url = `${baseUrl}/rest/api/latest/issue/${encodeURIComponent(key)}?fields=summary,description`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error(`Issue ${key} not found`);
    throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  const summary: string = data.fields?.summary ?? '';
  const rawDesc: string = data.fields?.description ?? '';
  const { description, acceptanceCriteria, releaseNotes, developerTasks } = parseDescription(rawDesc);

  return { key: data.key ?? key, summary, description, acceptanceCriteria, releaseNotes, developerTasks };
}
