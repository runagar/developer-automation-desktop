import * as fs from 'fs';
import * as path from 'path';

interface WhitelistConfig {
  profiles: Record<string, string[]>;
  activeProfile: string;
}

const DEFAULT_CONFIG: WhitelistConfig = {
  profiles: {
    default: ['NRPACR', 'NRPAV', 'NRPCON', 'NRPCR', 'NRPMG', 'NRPP', 'NRPPRO', 'NRPSHOL', 'RPS'],
  },
  activeProfile: 'default',
};

function configPath(dataDir: string): string {
  return path.join(dataDir, 'jira-whitelist.json');
}

/**
 * Ensure the whitelist config file exists. Creates it with the default profile
 * on first run.
 */
export function ensureWhitelistConfig(dataDir: string): void {
  const p = configPath(dataDir);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  console.log(`[whitelist] Created default whitelist config at ${p}`);
}

/**
 * Load the active whitelist profile's project prefixes.
 * Returns an empty array if the config is missing or corrupt (follow everything).
 */
export function loadWhitelist(dataDir: string): string[] {
  try {
    const raw = fs.readFileSync(configPath(dataDir), 'utf-8');
    const config = JSON.parse(raw) as WhitelistConfig;
    const profile = config.profiles?.[config.activeProfile];
    return Array.isArray(profile) ? profile : [];
  } catch {
    return [];
  }
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(dataDir: string): string {
  try {
    const raw = fs.readFileSync(configPath(dataDir), 'utf-8');
    const config = JSON.parse(raw) as WhitelistConfig;
    return config.activeProfile ?? 'default';
  } catch {
    return 'default';
  }
}
