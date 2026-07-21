import * as fs from 'fs';
import * as path from 'path';
import { getNotesRootPath, setNotesRootPath } from './settings';
import { NotesManager } from './notes';
import { copyDirRecursive, rollbackCopiedFiles, validatePathWritable } from './migrationUtils';

/**
 * Migrate notes to a new root path.
 * Copies all files, updates settings, updates NotesManager runtime root, then deletes old copy.
 * No DB updates needed — file_path values are stored as relative paths.
 */
export async function migrateNotesRoot(
  dataDir: string,
  newPath: string,
  notesManager: NotesManager,
): Promise<{ success: boolean; error?: string }> {
  const oldPath = getNotesRootPath(dataDir);
  const normalizedNew = path.resolve(newPath);
  const normalizedOld = path.resolve(oldPath);

  if (normalizedNew === normalizedOld) {
    return { success: false, error: 'New path is the same as the current path' };
  }

  try {
    const writeError = validatePathWritable(normalizedNew);
    if (writeError) return { success: false, error: writeError };

    // Copy all files from old root to new root, tracking what was copied
    const copiedFiles: string[] = [];
    if (fs.existsSync(normalizedOld)) {
      try {
        copyDirRecursive(normalizedOld, normalizedNew, copiedFiles);
      } catch (err: any) {
        rollbackCopiedFiles(copiedFiles);
        return { success: false, error: `Copy failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // Update settings and runtime path
    setNotesRootPath(dataDir, normalizedNew);
    notesManager.setNotesRoot(normalizedNew);

    // Delete old root
    if (fs.existsSync(normalizedOld)) {
      try { fs.rmSync(normalizedOld, { recursive: true, force: true }); } catch { /* ok */ }
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Migration failed' };
  }
}
