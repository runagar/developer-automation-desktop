import { autoUpdater, UpdateInfo, UpdateDownloadedEvent } from 'electron-updater';
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawnSync } from 'child_process';

export interface UpdaterStatus {
  state: 'downloading' | 'ready' | 'installing' | 'manual';
  version: string;
  /** Only set for `manual`: the command the user must run to finish the update. */
  command?: string;
}

let win: BrowserWindow | null = null;
let downloadedFile: string | null = null;
let downloadedVersion = '';
let installRequested = false;
let installing = false;

function send(status: UpdaterStatus): void {
  win?.webContents.send('updater:status', status);
}

/** Quote for a POSIX shell — the command is copied and pasted by the user. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sendManual(): void {
  if (!downloadedFile) return;
  // Reset so a later unrelated updater error cannot resurrect this banner.
  installRequested = false;
  send({
    state: 'manual',
    version: downloadedVersion,
    command: `sudo dpkg -i ${shellQuote(downloadedFile)}`,
  });
}

/** Runs a privileged command. No shell, so arguments need no escaping. */
function sudo(args: string[]) {
  return spawnSync('sudo', ['-n', ...args], { encoding: 'utf-8', timeout: 5 * 60_000 });
}

/** Reads a value from a command, or null if it fails. */
function query(cmd: string, args: string[]): string | null {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * True when sudo escalates without prompting.
 *
 * electron-updater picks the first of gksudo/kdesudo/pkexec that exists and
 * never falls back to plain sudo. Under WSLg pkexec is installed but no polkit
 * authentication agent runs, so it always exits 127 ("No authentication agent
 * found") and the update fails. Checking sudo first gives us a working
 * unattended path there.
 */
function canSudoNonInteractively(): boolean {
  try {
    return spawnSync('sudo', ['-n', 'true'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Mirrors electron-updater's dpkg-then-apt-get recovery, but via sudo. */
function installDeb(file: string): boolean {
  const pkg = query('dpkg-deb', ['-f', file, 'Package']);
  const wanted = query('dpkg-deb', ['-f', file, 'Version']);

  let result = sudo(['dpkg', '-i', file]);
  if (result.status !== 0) {
    console.warn('[updater] dpkg failed, fixing dependencies:', result.stderr?.trim());
    result = sudo(['apt-get', 'install', '-f', '-y']);
  }

  // `apt-get install -f` exits 0 whenever there is nothing broken to fix, even
  // if the new package never got unpacked. Confirm against the package database
  // instead of trusting the exit code, so a failed update is never mistaken for
  // a successful one (which would relaunch straight back into the old version).
  if (pkg && wanted) {
    const installed = query('dpkg-query', ['-W', '-f=${Version}', pkg]);
    if (installed === wanted) return true;
    console.error(`[updater] Install did not take: ${pkg} is ${installed ?? 'absent'}, expected ${wanted}`);
    return false;
  }

  if (result.status !== 0) console.error('[updater] Install failed:', result.stderr?.trim());
  return result.status === 0;
}

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    installRequested = false;
    send({ state: 'downloading', version: info.version });
  });

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    downloadedFile = event.downloadedFile;
    downloadedVersion = event.version;
    send({ state: 'ready', version: event.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    // An error once the user has asked to install means privilege escalation
    // failed. Surface the manual command rather than appearing to do nothing.
    if (installRequested) sendManual();
  });

  ipcMain.on('updater:install', () => {
    if (installing) return;
    installRequested = true;

    if (process.platform === 'linux' && downloadedFile?.endsWith('.deb') && canSudoNonInteractively()) {
      installing = true;
      // Notify before blocking: installDeb() freezes the main process for the
      // duration of dpkg, and a user who assumes the app has hung may kill it
      // mid-install, leaving dpkg needing a manual `dpkg --configure -a`.
      send({ state: 'installing', version: downloadedVersion });

      if (installDeb(downloadedFile)) {
        // Already installed — stop electron-updater's quit handler from running
        // the installer a second time.
        autoUpdater.autoInstallOnAppQuit = false;
        app.relaunch();
        app.quit();
      } else {
        installing = false;
        sendManual();
      }
      return;
    }

    // A desktop session with a polkit agent can still escalate through
    // electron-updater. If it cannot, its error routes to sendManual().
    autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.checkForUpdates().catch(() => {});
}
