import { IpcMain } from 'electron';
import { SessionManager } from '../sessions';
import { fetchJiraIssue, fetchIssueGraph, clearCredentialCache } from '../jira';
import { JiraIssue } from '../types';
import { writeIssueNote, getVaultRoot, readFromVault } from '../vault';
import { loadWhitelist } from '../whitelist';
import { getJiraVaultPath } from '../settings';

export function registerJiraHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  dataDir: string,
): void {
  ipcMain.handle('jira:fetchIssue', (_event, key: string) => fetchJiraIssue(key));

  ipcMain.handle('jira:fetchAndPopulateVault', async (_event, key: string) => {
    const whitelist = loadWhitelist(dataDir);
    const { primary, related, filtered } = await fetchIssueGraph(key, {
      linkedDepth: 1, linkLimit: 8, maxIssues: 30,
      whitelist, maintenanceEpic: 'NRPPRO-326',
    });
    const vaultRoot = getVaultRoot(dataDir);
    writeIssueNote(vaultRoot, primary, filtered);
    for (const issue of related) writeIssueNote(vaultRoot, issue);
    return primary;
  });

  ipcMain.handle('jira:writeToVault', (_event, issue: JiraIssue) => {
    writeIssueNote(getVaultRoot(dataDir), issue);
  });

  ipcMain.handle('jira:readIssue', (_event, key: string) => {
    return readFromVault(getVaultRoot(dataDir), key);
  });

  ipcMain.handle('jira:getOrFetch', async (_event, key: string) => {
    const vaultRoot = getVaultRoot(dataDir);
    const cached = readFromVault(vaultRoot, key);
    if (cached) return cached;
    const fetched = await fetchJiraIssue(key);
    writeIssueNote(vaultRoot, fetched);
    return fetched;
  });

  ipcMain.handle('jira:saveIssue', (_event, sessionId: string, issue: JiraIssue) => {
    sessionManager.saveJiraIssue(sessionId, issue);
  });

  ipcMain.handle('jira:clearIssue', (_event, sessionId: string) => {
    sessionManager.clearJiraIssue(sessionId);
  });
}
