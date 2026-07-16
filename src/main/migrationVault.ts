import * as fs from 'fs';
import * as path from 'path';
import { getJiraVaultPath, setJiraVaultPath } from './settings';
import { clearCredentialCache } from './jira';

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
    // Validate new path is writable
    fs.mkdirSync(normalizedNew, { recursive: true });
    const testFile = path.join(normalizedNew, '.write-test');
    try {
      fs.writeFileSync(testFile, '', 'utf-8');
      fs.unlinkSync(testFile);
    } catch {
      return { success: false, error: `Path is not writable: ${normalizedNew}` };
    }

    // Copy old vault contents if they exist
    const copiedFiles: string[] = [];
    if (fs.existsSync(normalizedOld)) {
      try {
        copyDirRecursive(normalizedOld, normalizedNew, copiedFiles);
      } catch (err: any) {
        // Rollback: only delete files we actually copied
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

/**
 * Recursively copy a directory, skipping files that already exist at the destination.
 * Records all newly created files in `copiedFiles` for rollback.
 */
function copyDirRecursive(src: string, dest: string, copiedFiles: string[]): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, copiedFiles);
    } else {
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        copiedFiles.push(destPath);
      }
    }
  }
}

/** Delete only the files that were copied during migration. */
function rollbackCopiedFiles(copiedFiles: string[]): void {
  for (const f of copiedFiles) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
}
