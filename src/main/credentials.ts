import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Credential field manifest
// ---------------------------------------------------------------------------

export interface CredentialField {
  key: string;
  label: string;
  group: string;
  sensitive: boolean;
  required: boolean;
  placeholder?: string;
}

export const CREDENTIAL_FIELDS: CredentialField[] = [
  { key: 'ATLASSIAN_PAT', label: 'Access Token', group: 'Atlassian', sensitive: true, required: true },
  { key: 'ATLASSIAN_BASE_URL', label: 'Base URL', group: 'Atlassian', sensitive: false, required: true, placeholder: 'https://jira.example.com/' },
];

export interface CredentialStatus {
  key: string;
  label: string;
  group: string;
  sensitive: boolean;
  required: boolean;
  placeholder?: string;
  source: 'env' | 'file' | 'none';
  value: string;
}

// ---------------------------------------------------------------------------
// .env file helpers
// ---------------------------------------------------------------------------

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'credentials.env');
}

// ---------------------------------------------------------------------------
// Status / read
// ---------------------------------------------------------------------------

export function getCredentialStatus(dataDir: string): CredentialStatus[] {
  const filePath = credentialsPath(dataDir);
  const fileVals = parseEnvFile(filePath);

  return CREDENTIAL_FIELDS.map((field) => {
    const envVal = process.env[field.key];
    if (envVal) {
      return { ...field, source: 'env' as const, value: envVal };
    }
    const fileVal = fileVals[field.key];
    if (fileVal) {
      return { ...field, source: 'file' as const, value: fileVal };
    }
    return { ...field, source: 'none' as const, value: '' };
  });
}

/**
 * Resolve a credential value from env var → file → empty.
 */
export function resolveCredential(dataDir: string, key: string): string {
  const envVal = process.env[key];
  if (envVal) return envVal;
  const fileVals = parseEnvFile(credentialsPath(dataDir));
  return fileVals[key] ?? '';
}

// ---------------------------------------------------------------------------
// Write / clear
// ---------------------------------------------------------------------------

export function saveCredential(dataDir: string, key: string, value: string): void {
  const filePath = credentialsPath(dataDir);
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';

  const lines = existing.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const eqIdx = trimmed.indexOf('=');
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  // Remove trailing empty lines, add final newline
  const content = updated.filter((l, i, arr) => i < arr.length - 1 || l.trim() !== '').join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

export function clearCredential(dataDir: string, key: string): void {
  const filePath = credentialsPath(dataDir);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return true;
    const eqIdx = trimmed.indexOf('=');
    return trimmed.slice(0, eqIdx).trim() !== key;
  });

  fs.writeFileSync(filePath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  key: string;
  valid: boolean;
  error?: string;
}

/**
 * Validate a set of credential updates.
 * Uses the combination of updated values + existing env/file values for context.
 */
export async function validateCredentials(
  dataDir: string,
  updates: Array<{ key: string; value: string }>
): Promise<ValidationResult[]> {
  const updateMap = new Map(updates.map((u) => [u.key, u.value]));
  const results: ValidationResult[] = [];

  // Group updates by manifest group
  const groups = new Map<string, string[]>();
  for (const u of updates) {
    const field = CREDENTIAL_FIELDS.find((f) => f.key === u.key);
    if (!field) continue;
    const keys = groups.get(field.group) ?? [];
    keys.push(u.key);
    groups.set(field.group, keys);
  }

  // Validate Atlassian group
  const atlassianKeys = groups.get('Atlassian');
  if (atlassianKeys) {
    const pat = updateMap.get('ATLASSIAN_PAT') ?? resolveCredential(dataDir, 'ATLASSIAN_PAT');
    const baseUrl = updateMap.get('ATLASSIAN_BASE_URL') ?? resolveCredential(dataDir, 'ATLASSIAN_BASE_URL');

    if (!pat || !baseUrl) {
      // Can't validate without both — mark updated keys as undetermined
      for (const key of atlassianKeys) {
        results.push({ key, valid: false, error: 'Both Access Token and Base URL are required for validation' });
      }
    } else {
      const url = `${baseUrl.replace(/\/$/, '')}/rest/api/latest/myself`;
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        });
        if (response.ok) {
          for (const key of atlassianKeys) {
            results.push({ key, valid: true });
          }
        } else if (response.status === 401 || response.status === 403) {
          // Token is invalid
          const patUpdated = updateMap.has('ATLASSIAN_PAT');
          const urlUpdated = updateMap.has('ATLASSIAN_BASE_URL');
          if (patUpdated) {
            results.push({ key: 'ATLASSIAN_PAT', valid: false, error: 'Authentication failed — invalid token' });
          }
          if (urlUpdated) {
            // URL might be fine, but we can't tell — don't save
            results.push({ key: 'ATLASSIAN_BASE_URL', valid: false, error: 'Authentication failed — cannot verify URL' });
          }
        } else if (response.status === 404) {
          // URL is wrong (API endpoint not found)
          if (updateMap.has('ATLASSIAN_BASE_URL')) {
            results.push({ key: 'ATLASSIAN_BASE_URL', valid: false, error: `API not found at this URL (HTTP ${response.status})` });
          }
          if (updateMap.has('ATLASSIAN_PAT')) {
            results.push({ key: 'ATLASSIAN_PAT', valid: false, error: 'Cannot validate — Base URL appears incorrect' });
          }
        } else {
          for (const key of atlassianKeys) {
            results.push({ key, valid: false, error: `Unexpected response: HTTP ${response.status}` });
          }
        }
      } catch (err: any) {
        // Network error — likely bad URL
        if (updateMap.has('ATLASSIAN_BASE_URL')) {
          results.push({ key: 'ATLASSIAN_BASE_URL', valid: false, error: `Connection failed: ${err?.message ?? 'unknown error'}` });
        }
        if (updateMap.has('ATLASSIAN_PAT')) {
          results.push({ key: 'ATLASSIAN_PAT', valid: false, error: 'Cannot validate — connection to server failed' });
        }
      }
    }
  }

  return results;
}
