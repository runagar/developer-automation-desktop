import * as fs from 'fs';
import * as path from 'path';
import {
  encodeEnvValue, getJiraSettings, JiraClient, JiraError,
  parseEnv, updateJiraSettings,
} from '@rulu/jira-tools';

export { decodeEnvValue, encodeEnvValue } from '@rulu/jira-tools';

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
  return parseEnv(fs.readFileSync(filePath, 'utf-8'));
}

export function isJiraCredential(key: string): key is 'ATLASSIAN_PAT' | 'ATLASSIAN_BASE_URL' {
  return key === 'ATLASSIAN_PAT' || key === 'ATLASSIAN_BASE_URL';
}

function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'credentials.env');
}

// ---------------------------------------------------------------------------
// Status / read
// ---------------------------------------------------------------------------

export async function getCredentialStatus(dataDir: string): Promise<CredentialStatus[]> {
  const filePath = credentialsPath(dataDir);
  const fileVals = parseEnvFile(filePath);
  const jira = await getJiraSettings();

  return CREDENTIAL_FIELDS.map((field) => {
    if (isJiraCredential(field.key)) {
      return { ...field, source: jira.sources[field.key], value: field.key === 'ATLASSIAN_PAT' ? jira.pat : jira.baseUrl };
    }
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

export async function saveManagedCredentials(dataDir: string, updates: Array<{ key: string; value: string }>): Promise<void> {
  const atlassian = new Map(updates.filter((update) => isJiraCredential(update.key)).map((update) => [update.key, update.value]));
  if (atlassian.size) {
    await updateJiraSettings({ pat: atlassian.get('ATLASSIAN_PAT'), baseUrl: atlassian.get('ATLASSIAN_BASE_URL') });
  }
  for (const update of updates) {
    if (!isJiraCredential(update.key)) saveCredential(dataDir, update.key, update.value);
  }
}

export async function clearManagedCredential(dataDir: string, key: string): Promise<void> {
  if (isJiraCredential(key)) {
    await updateJiraSettings(key === 'ATLASSIAN_PAT' ? { pat: '' } : { baseUrl: '' });
  } else {
    clearCredential(dataDir, key);
  }
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
    const jira = await getJiraSettings();
    const pat = updateMap.get('ATLASSIAN_PAT') ?? jira.pat;
    const baseUrl = updateMap.get('ATLASSIAN_BASE_URL') ?? jira.baseUrl;

    if (!pat || !baseUrl) {
      // Can't validate without both — mark updated keys as undetermined
      for (const key of atlassianKeys) {
        results.push({ key, valid: false, error: 'Both Access Token and Base URL are required for validation' });
      }
    } else {
      try {
        await new JiraClient({ credentials: { pat, baseUrl } }).getCurrentUser();
        for (const key of atlassianKeys) results.push({ key, valid: true });
      } catch (error) {
        const message = error instanceof JiraError ? error.message : 'Cannot validate Jira credentials';
        for (const key of atlassianKeys) {
          results.push({ key, valid: false, error: message });
        }
      }
    }
  }

  return results;
}
