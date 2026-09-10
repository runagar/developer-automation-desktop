import { IpcMain } from 'electron';
import { SessionManager } from '../sessions';
import { fetchJiraIssue, fetchIssueGraph, clearCredentialCache } from '../jira';
import { JiraIssue } from '../types';
import { writeIssueNote, getVaultRoot, readVaultNote } from '../vault';
import { createRefresher } from '../jiraRefresh';
import { loadWhitelist } from '../whitelist';
import { getJiraVaultPath } from '../settings';

export function registerJiraHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  dataDir: string,
): void {
  // One refresher for the whole app: single-flight and failure backoff are only
  // meaningful if every entry point shares them.
  const refresher = createRefresher({
    fetchIssue: fetchJiraIssue,
    readNote: (key) => readVaultNote(getVaultRoot(dataDir), key),
    writeNote: (issue) => writeIssueNote(getVaultRoot(dataDir), issue),
  });

  ipcMain.handle('jira:fetchIssue', (_event, key: string) => fetchJiraIssue(key));

  ipcMain.handle('jira:fetchAndPopulateVault', async (_event, key: string, force?: boolean) => {
    const whitelist = loadWhitelist(dataDir);
    const { primary } = await fetchIssueGraph(key, {
      linkedDepth: 1, linkLimit: 8, maxIssues: 30,
      whitelist, maintenanceEpic: 'NRPPRO-326',
      // The primary is never tiered; secondaries are. `force` (the manual FETCH
      // button) bypasses freshness and backoff for the whole graph.
      resolve: (k, kind) => refresher.resolve(k, {
        tiered: kind === 'secondary',
        force: force === true,
      }),
    });
    return primary;
  });

  ipcMain.handle('jira:writeToVault', (_event, issue: JiraIssue) => {
    writeIssueNote(getVaultRoot(dataDir), issue);
  });

  ipcMain.handle('jira:readIssue', async (_event, key: string) => {
    return (await readVaultNote(getVaultRoot(dataDir), key))?.issue ?? null;
  });

  ipcMain.handle('jira:getOrFetch', async (_event, key: string) => {
    // A click-through is the user asking for that issue directly, so it is
    // treated as a primary: always refetched, with the cached note used only
    // when the fetch fails.
    const outcome = await refresher.resolve(key, { tiered: false });
    if (!outcome.issue) throw (outcome as { error: Error }).error;
    return outcome.issue;
  });

  ipcMain.handle('jira:saveIssue', (_event, sessionId: string, issue: JiraIssue) => {
    sessionManager.saveJiraIssue(sessionId, issue);
  });

  ipcMain.handle('jira:clearIssue', (_event, sessionId: string) => {
    sessionManager.clearJiraIssue(sessionId);
  });
}
