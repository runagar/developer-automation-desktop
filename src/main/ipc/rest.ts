import { IpcMain } from 'electron';
import {
  DEFAULT_ENVIRONMENT_KEY, REST_ENVIRONMENTS, RestEnvironment, findEnvironment,
} from '../environments';
import { RestRequest, RestResult, executeRequest, tokenForEnvironment } from '../rest';
import { AuthConfigurationError, AuthUnavailableError, CredentialsRejectedError } from '../nykAuth';

/**
 * Turn an auth failure into the same wording the LOGIN button uses.
 *
 * The crafter shows this inline (ambiguity 10) rather than inventing a second
 * vocabulary for the same three failure modes.
 */
function tokenErrorMessage(err: unknown): string {
  if (err instanceof CredentialsRejectedError) return err.message;
  if (err instanceof AuthConfigurationError) return err.message;
  if (err instanceof AuthUnavailableError) return err.message;
  const message = (err as any)?.message;
  return message ? String(message) : 'Could not obtain a token for this environment';
}

export function registerRestHandlers(ipcMain: IpcMain, dataDir: string): void {
  ipcMain.handle('rest:environments', (): RestEnvironment[] => REST_ENVIRONMENTS);

  /**
   * The bearer value for an environment.
   *
   * R2 kept tokens inside the main process; requirement 6.2.3 deliberately
   * relaxes that so the Authorization header can be shown and edited. The
   * token still never reaches disk — it is excluded from the request draft.
   */
  ipcMain.handle('rest:token', async (_e, environmentKey: string): Promise<string> => {
    const env = findEnvironment(environmentKey) ?? findEnvironment(DEFAULT_ENVIRONMENT_KEY)!;
    try {
      return await tokenForEnvironment(dataDir, env);
    } catch (err) {
      throw new Error(tokenErrorMessage(err));
    }
  });

  ipcMain.handle('rest:send', (_e, request: RestRequest): Promise<RestResult> =>
    executeRequest(dataDir, request));
}
