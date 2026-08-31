import { IpcMain, BrowserWindow } from 'electron';
import {
  apiDocsTarget, clearCaches, getDefinitions, listOperations,
  listServices, listVersions, buildSelection, loadConfig,
  ContractType, OperationRow, RestSelection, ServiceVersions,
} from '../apidocs';
import {
  AuthConfigurationError, AuthReason, AuthState, CredentialsRejectedError,
  acquireToken, cacheToken, clearLatch, clearTokens, getToken, latchRejected, readCredentials,
} from '../nykAuth';
import { resolveCredential, saveCredential } from '../credentials';

const VERIFY_TIMEOUT_MS = 20_000;

export interface AuthStatus {
  state: AuthState;
  reason: AuthReason;
  message: string;
  username: string;
  /** Where the password comes from — never the password itself. */
  passwordSource: 'env' | 'file' | 'none';
}

let current: AuthStatus = {
  state: 'no-credentials', reason: null, message: '', username: '', passwordSource: 'none',
};

function passwordSource(dataDir: string): 'env' | 'file' | 'none' {
  if (process.env.NYK_PASSWORD) return 'env';
  return resolveCredential(dataDir, 'NYK_PASSWORD') ? 'file' : 'none';
}

function broadcast(getWindow: () => BrowserWindow | null): void {
  getWindow()?.webContents.send('auth:state-changed', current);
}

function setStatus(
  dataDir: string,
  getWindow: () => BrowserWindow | null,
  patch: Partial<AuthStatus>
): AuthStatus {
  current = {
    ...current,
    ...patch,
    username: resolveCredential(dataDir, 'NYK_USERNAME'),
    passwordSource: passwordSource(dataDir),
  };
  broadcast(getWindow);
  return current;
}

/**
 * Confirm the token is actually accepted by api-docs.
 *
 * Acquiring a token only proves the credentials are right — a token minted for
 * the wrong client id authenticates fine and is then refused with 403.
 */
async function verifyAgainstApiDocs(token: string): Promise<void> {
  const config = await loadConfig();
  const response = await fetch(`${config.apiBase}/authorizations`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (response.status === 403) {
    throw new AuthConfigurationError(
      'API-docs rejected the token (wrong OAuth client id) — this is a configuration problem, not a password problem'
    );
  }
  if (!response.ok) {
    throw new Error(`API-docs returned HTTP ${response.status}`);
  }
}

function classify(err: unknown): { state: AuthState; reason: AuthReason; message: string } {
  if (err instanceof CredentialsRejectedError) {
    return { state: 'login-failed', reason: 'rejected', message: err.message };
  }
  if (err instanceof AuthConfigurationError) {
    return { state: 'unavailable', reason: 'configuration', message: err.message };
  }
  return {
    state: 'unavailable',
    reason: 'network',
    message: (err as any)?.message ?? 'Could not reach the Nykredit authorisation server',
  };
}

/**
 * Verify one credential pair end to end.
 *
 * `manual` marks a user-initiated login, which is the only thing allowed to
 * bypass and clear the rejection latch. Automatic attempts go through
 * `getToken` so they share its single-flight guard — otherwise the startup
 * attempt and the picker's first fetch could each fire an authentication in the
 * same tick, neither seeing the other's rejection, which is exactly the burst
 * the latch exists to prevent.
 */
async function attemptLogin(
  dataDir: string,
  getWindow: () => BrowserWindow | null,
  creds: { username: string; password: string },
  manual: boolean
): Promise<AuthStatus> {
  if (!creds.username || !creds.password) {
    return setStatus(dataDir, getWindow, {
      state: 'no-credentials', reason: null,
      message: 'No Nykredit credentials configured',
    });
  }

  try {
    const target = await apiDocsTarget();
    const token = manual
      ? await acquireToken(target, creds)
      : await getToken(dataDir, target);
    await verifyAgainstApiDocs(token);

    if (manual) {
      saveCredential(dataDir, 'NYK_USERNAME', creds.username);
      // A password supplied by environment variable is deliberately not written
      // to disk — the env var already is the source of truth.
      if (!process.env.NYK_PASSWORD) saveCredential(dataDir, 'NYK_PASSWORD', creds.password);
      clearLatch(dataDir);
      cacheToken(target, token);
    }
    return setStatus(dataDir, getWindow, { state: 'logged-in', reason: null, message: '' });
  } catch (err) {
    const classified = classify(err);
    // getToken latches its own failures; a manual attempt must record its own.
    if (manual && classified.reason === 'rejected') latchRejected(dataDir, creds);
    return setStatus(dataDir, getWindow, classified);
  }
}

export function registerAuthHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  dataDir: string,
): void {
  ipcMain.handle('auth:status', (): AuthStatus => {
    const creds = readCredentials(dataDir);
    if (!creds.username || !creds.password) {
      current = { ...current, state: 'no-credentials', reason: null, message: '' };
    }
    return {
      ...current,
      username: resolveCredential(dataDir, 'NYK_USERNAME'),
      passwordSource: passwordSource(dataDir),
    };
  });

  ipcMain.handle('auth:login', (_e, username: string, password: string) => {
    // When the password comes from the environment the dialog cannot edit it,
    // but the username still may be wrong. Taking the password from the
    // environment here keeps the manual (latch-bypassing) path reachable, so a
    // corrected username can always be tried.
    const effectivePassword = process.env.NYK_PASSWORD || password;
    return attemptLogin(dataDir, getWindow, { username, password: effectivePassword }, true);
  });

  ipcMain.handle('auth:retry', () =>
    attemptLogin(dataDir, getWindow, readCredentials(dataDir), false));

  ipcMain.handle('auth:startup', () =>
    attemptLogin(dataDir, getWindow, readCredentials(dataDir), false));

  ipcMain.handle('auth:logout', (): AuthStatus => {
    clearTokens();
    return setStatus(dataDir, getWindow, {
      state: 'no-credentials', reason: null, message: '',
    });
  });

  // -------------------------------------------------------------------------
  // api-docs
  // -------------------------------------------------------------------------

  ipcMain.handle('apidocs:services', (): Promise<string[]> => listServices(dataDir));

  ipcMain.handle('apidocs:versions', (_e, service: string): Promise<ServiceVersions> =>
    listVersions(dataDir, service));

  ipcMain.handle('apidocs:operations',
    (_e, service: string, type: ContractType, version: string): Promise<OperationRow[]> =>
      listOperations(dataDir, service, type, version));

  ipcMain.handle('apidocs:selection',
    (_e, service: string, type: ContractType, version: string,
     method: string, path: string, acceptVersion: string | null): Promise<RestSelection | null> =>
      buildSelection(dataDir, service, type, version, method, path, acceptVersion));

  ipcMain.handle('apidocs:definitions',
    (_e, service: string, type: ContractType, version: string): Promise<Record<string, unknown>> =>
      getDefinitions(dataDir, service, type, version));

  ipcMain.handle('apidocs:refresh', (): void => {
    clearCaches();
  });
}
