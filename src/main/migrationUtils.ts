import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively copy a directory, skipping files that already exist at the destination.
 * Records all newly created files in `copiedFiles` for rollback.
 */
export function copyDirRecursive(src: string, dest: string, copiedFiles: string[]): void {
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

/** Delete only the files that were copied during migration (rollback). */
export function rollbackCopiedFiles(copiedFiles: string[]): void {
  for (const f of copiedFiles) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
}

/**
 * Validate that a directory path is writable by creating a test file.
 * Creates the directory if it doesn't exist.
 * Returns an error message if not writable, or null if OK.
 */
export function validatePathWritable(dirPath: string): string | null {
  fs.mkdirSync(dirPath, { recursive: true });
  const testFile = path.join(dirPath, '.write-test');
  try {
    fs.writeFileSync(testFile, '', 'utf-8');
    fs.unlinkSync(testFile);
    return null;
  } catch {
    return `Path is not writable: ${dirPath}`;
  }
}
