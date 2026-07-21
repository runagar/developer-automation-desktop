import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { IpcApi, Session, SessionState, WorkspaceEntry, JiraIssue } from '../main/types';

const api: IpcApi = {
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  destroySession: (id) => ipcRenderer.invoke('sessions:destroy', id),
  archiveSession: (id) => ipcRenderer.invoke('sessions:archive', id),
  unarchiveSession: (id, cols, rows) => ipcRenderer.invoke('sessions:unarchive', id, cols, rows),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
  reorderSessions: (orderedIds) => ipcRenderer.invoke('sessions:reorder', orderedIds),
  reviveSession: (id, cols, rows) => ipcRenderer.invoke('sessions:revive', id, cols, rows),
  resumeSession: (id) => ipcRenderer.invoke('sessions:resume', id),

  ptyWrite: (sessionId, data) => ipcRenderer.send('pty:write', sessionId, data),
  ptyResize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),

  getWorkspaces: () => ipcRenderer.invoke('workspaces:get'),
  getWorkspaceGroups: () => ipcRenderer.invoke('workspaces:getGroups'),
  addWorkspace: (opts) => ipcRenderer.invoke('workspaces:add', opts),
  removeWorkspace: (key) => ipcRenderer.invoke('workspaces:remove', key),
  addGroup: (name) => ipcRenderer.invoke('workspaces:addGroup', name),
  removeGroup: (name) => ipcRenderer.invoke('workspaces:removeGroup', name),
  moveWorkspace: (key, toGroup, toIndex) => ipcRenderer.invoke('workspaces:move', key, toGroup, toIndex),
  reorderGroup: (name, toIndex) => ipcRenderer.invoke('workspaces:reorderGroup', name, toIndex),

  // Settings
  getDefaultWorkingRoot: () => ipcRenderer.invoke('settings:getDefaultRoot'),
  setDefaultWorkingRoot: (root) => ipcRenderer.invoke('settings:setDefaultRoot', root),
  getJiraVaultPath: () => ipcRenderer.invoke('settings:getJiraVaultPath'),
  setJiraVaultPath: (vaultPath) => ipcRenderer.invoke('settings:setJiraVaultPath', vaultPath),
  getNotesRootPath: () => ipcRenderer.invoke('settings:getNotesRoot'),
  setNotesRootPath: (rootPath) => ipcRenderer.invoke('settings:setNotesRoot', rootPath),
  migrateJiraVault: (newPath) => ipcRenderer.invoke('jira:migrateVault', newPath),
  migrateNotesRoot: (newPath) => ipcRenderer.invoke('notes:migrateRoot', newPath),
  isPathNonEmpty: (dirPath) => ipcRenderer.invoke('settings:isPathNonEmpty', dirPath),
  isFirstLaunch: () => ipcRenderer.invoke('settings:isFirstLaunch'),
  markFirstLaunchComplete: () => ipcRenderer.invoke('settings:markFirstLaunchComplete'),

  // Jira
  fetchJiraIssue: (key) => ipcRenderer.invoke('jira:fetchIssue', key),
  fetchAndPopulateVault: (key) => ipcRenderer.invoke('jira:fetchAndPopulateVault', key),
  writeToVault: (issue) => ipcRenderer.invoke('jira:writeToVault', issue),
  readJiraIssue: (key) => ipcRenderer.invoke('jira:readIssue', key),
  getOrFetchJiraIssue: (key) => ipcRenderer.invoke('jira:getOrFetch', key),
  saveJiraIssue: (sessionId, issue) => ipcRenderer.invoke('jira:saveIssue', sessionId, issue),
  clearJiraIssue: (sessionId) => ipcRenderer.invoke('jira:clearIssue', sessionId),

  // PTY attach/detach (panel-instance-aware)
  ptyAttach: (sessionId, panelInstanceId, cols, rows) =>
    ipcRenderer.invoke('pty:attach', sessionId, panelInstanceId, cols, rows),
  ptyDetach: (panelInstanceId) => ipcRenderer.invoke('pty:detach', panelInstanceId),
  ptyWritePanel: (panelInstanceId, data) => ipcRenderer.send('pty:writePanel', panelInstanceId, data),
  ptyResizePanel: (panelInstanceId, cols, rows) =>
    ipcRenderer.invoke('pty:resizePanel', panelInstanceId, cols, rows),

  // Shell tmux (panel-instance-aware)
  shellAttach: (sessionId, panelInstanceId, workingDir, cols, rows) =>
    ipcRenderer.invoke('shell:attach', sessionId, panelInstanceId, workingDir, cols, rows),
  shellDetach: (panelInstanceId) => ipcRenderer.invoke('shell:detach', panelInstanceId),
  shellWritePanel: (panelInstanceId, data) => ipcRenderer.send('shell:writePanel', panelInstanceId, data),
  shellResizePanel: (panelInstanceId, cols, rows) =>
    ipcRenderer.invoke('shell:resizePanel', panelInstanceId, cols, rows),
  shellDestroyTmux: (sessionId) => ipcRenderer.invoke('shell:destroyTmux', sessionId),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  onWindowMaximized: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },

  // Clipboard (synchronous IPC — clipboard module is only available in main process)
  clipboardWrite: (text) => ipcRenderer.sendSync('clipboard:write', text),
  clipboardRead: () => ipcRenderer.sendSync('clipboard:read'),

  // Zoom (uses webFrame — no IPC round-trip needed)
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),

  onPtyData: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, panelInstanceId: string, data: string) =>
      callback(panelInstanceId, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  onShellData: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, panelInstanceId: string, data: string) =>
      callback(panelInstanceId, data);
    ipcRenderer.on('shell:data', listener);
    return () => ipcRenderer.removeListener('shell:data', listener);
  },

  onShellExit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, panelInstanceId: string) =>
      callback(panelInstanceId);
    ipcRenderer.on('shell:exit', listener);
    return () => ipcRenderer.removeListener('shell:exit', listener);
  },

  onSessionStateChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, state: SessionState) =>
      callback(sessionId, state);
    ipcRenderer.on('session:stateChange', listener);
    return () => ipcRenderer.removeListener('session:stateChange', listener);
  },

  onSessionDied: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) =>
      callback(sessionId);
    ipcRenderer.on('session:died', listener);
    return () => ipcRenderer.removeListener('session:died', listener);
  },

  onSessionArchived: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) =>
      callback(sessionId);
    ipcRenderer.on('session:archived', listener);
    return () => ipcRenderer.removeListener('session:archived', listener);
  },

  // Notes
  notesCreatePanel: (scope, panelId) => ipcRenderer.invoke('notes:createPanel', scope, panelId),
  notesClosePanel: (panelId) => ipcRenderer.invoke('notes:closePanel', panelId),
  notesDestroyPanel: (panelId) => ipcRenderer.invoke('notes:destroyPanel', panelId),
  notesRestorePanel: (panelId) => ipcRenderer.invoke('notes:restorePanel', panelId),
  notesGetClosedPanels: () => ipcRenderer.invoke('notes:getClosedPanels'),
  notesGetAllGlobalPanels: () => ipcRenderer.invoke('notes:getAllGlobalPanels'),
  notesRenamePanel: (panelId: string, name: string) => ipcRenderer.invoke('notes:renamePanel', panelId, name),
  notesCreateTab: (scope) => ipcRenderer.invoke('notes:createTab', scope),
  notesCloseTab: (tabId) => ipcRenderer.invoke('notes:closeTab', tabId),
  notesRestoreTab: (tabId) => ipcRenderer.invoke('notes:restoreTab', tabId),
  notesGetClosedTabs: (scope) => ipcRenderer.invoke('notes:getClosedTabs', scope),
  notesRenameTab: (tabId, name) => ipcRenderer.invoke('notes:renameTab', tabId, name),
  notesSaveContent: (tabId, content) => ipcRenderer.invoke('notes:saveContent', tabId, content),
  notesLoadContent: (tabId) => ipcRenderer.invoke('notes:loadContent', tabId),
  notesGetTabs: (scope) => ipcRenderer.invoke('notes:getTabs', scope),
  notesExportTab: (tabId) => ipcRenderer.invoke('notes:exportTab', tabId),
  notesCopyRef: (tabId) => ipcRenderer.invoke('notes:copyRef', tabId),

  // Credentials
  getCredentialStatus: () => ipcRenderer.invoke('credentials:status'),
  saveCredentials: (updates) => ipcRenderer.invoke('credentials:save', updates),
  clearCredential: (key) => ipcRenderer.invoke('credentials:clear', key),

  // Auto-updater
  onUpdaterStatus: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { state: 'downloading' | 'ready'; version: string }) => cb(status);
    ipcRenderer.on('updater:status', handler);
    return () => { ipcRenderer.removeListener('updater:status', handler); };
  },
  updaterInstall: () => ipcRenderer.send('updater:install'),
};

contextBridge.exposeInMainWorld('dad', api);

// Notify main that renderer is ready
ipcRenderer.send('renderer:ready');
