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
  { key: 'NYK_USERNAME', label: 'Initials', group: 'Nykredit', sensitive: false, required: true, placeholder: 'abcd' },
  { key: 'NYK_PASSWORD', label: 'Password', group: 'Nykredit', sensitive: true, required: true },
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
    env[trimmed.slice(0, eqIdx).trim()] = decodeEnvValue(trimmed.slice(eqIdx + 1).trim());
  }
  return env;
}

/**
 * Decode a stored value.
 *
 * Quoted values are unescaped; bare values are returned as-is so files written
 * by earlier versions keep parsing exactly as they did before.
 *
 * Escapes are consumed in a single left-to-right pass. Chained `replace` calls
 * would be wrong: unescaping `\n` before `\\` turns the encoded form of a
 * literal backslash-then-n (`\\n`, as in `c:\new`) into a real newline.
 */
export function decodeEnvValue(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;

  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\' || i === inner.length - 1) {
      out += inner[i];
      continue;
    }
    const next = inner[++i];
    if (next === 'n') out += '\n';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else out += `\\${next}`;
  }
  return out;
}

/**
 * Encode a value for storage, quoting only when it would not survive a
 * round-trip bare — a password may contain leading/trailing whitespace or a
 * newline, either of which the line-based parser would otherwise corrupt.
 */
export function encodeEnvValue(value: string): string {
  const needsQuoting = value !== value.trim() || /[\n\r"\\]/.test(value);
  if (!needsQuoting) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
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

function writeEnvFile(filePath: string, env: Record<string, string>): void {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${encodeEnvValue(v)}`)
    .join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies when creating the file — an existing one
  // keeps whatever permissions it already had.
  fs.chmodSync(filePath, 0o600);
}

export function saveCredential(dataDir: string, key: string, value: string): void {
  const filePath = credentialsPath(dataDir);
  const env = parseEnvFile(filePath);
  env[key] = value;
  writeEnvFile(filePath, env);
}

export function clearCredential(dataDir: string, key: string): void {
  const filePath = credentialsPath(dataDir);
  if (!fs.existsSync(filePath)) return;

  const env = parseEnvFile(filePath);
  delete env[key];
  writeEnvFile(filePath, env);
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
