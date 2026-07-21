import * as fs from 'fs';
import * as path from 'path';
import { getJiraVaultPath, setJiraVaultPath } from './settings';
import { clearCredentialCache } from './jira';
import { copyDirRecursive, rollbackCopiedFiles, validatePathWritable } from './migrationUtils';

/**
 * Migrate the Jira vault to a new path.
 * Copies the entire <oldRoot>/Jira/ subtree, updates settings, then deletes the old copy.
 * On error: cleans up partial copy and returns an error message.
 */
export async function migrateJiraVault(
  dataDir: string,
  newPath: string,
): Promise<{ success: boolean; error?: string }> {
  const oldPath = getJiraVaultPath(dataDir);
  const normalizedNew = path.resolve(newPath);
  const normalizedOld = path.resolve(oldPath);

  if (normalizedNew === normalizedOld) {
    return { success: false, error: 'New path is the same as the current path' };
  }

  try {
    const writeError = validatePathWritable(normalizedNew);
    if (writeError) return { success: false, error: writeError };

    // Copy old vault contents if they exist
    const copiedFiles: string[] = [];
    if (fs.existsSync(normalizedOld)) {
      try {
        copyDirRecursive(normalizedOld, normalizedNew, copiedFiles);
      } catch (err: any) {
        rollbackCopiedFiles(copiedFiles);
        return { success: false, error: `Copy failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // Update settings
    setJiraVaultPath(dataDir, normalizedNew);
    clearCredentialCache();

    // Delete old vault contents
    if (fs.existsSync(normalizedOld)) {
      try { fs.rmSync(normalizedOld, { recursive: true, force: true }); } catch { /* ok */ }
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Migration failed' };
  }
}
