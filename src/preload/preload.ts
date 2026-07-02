import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { IpcApi, Session, SessionState, ProjectEntry, JiraIssue } from '../main/types';

const api: IpcApi = {
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  destroySession: (id) => ipcRenderer.invoke('sessions:destroy', id),
  archiveSession: (id) => ipcRenderer.invoke('sessions:archive', id),
  unarchiveSession: (id, cols, rows) => ipcRenderer.invoke('sessions:unarchive', id, cols, rows),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
  reviveSession: (id, cols, rows) => ipcRenderer.invoke('sessions:revive', id, cols, rows),
  resumeSession: (id) => ipcRenderer.invoke('sessions:resume', id),

  ptyWrite: (sessionId, data) => ipcRenderer.send('pty:write', sessionId, data),
  ptyResize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),

  getProjects: () => ipcRenderer.invoke('projects:get'),
  getProjectGroups: () => ipcRenderer.invoke('projects:getGroups'),
  addProject: (entry) => ipcRenderer.invoke('projects:add', entry),
  removeProject: (key) => ipcRenderer.invoke('projects:remove', key),
  addGroup: (name) => ipcRenderer.invoke('projects:addGroup', name),
  removeGroup: (name) => ipcRenderer.invoke('projects:removeGroup', name),
  moveWorkspace: (key, toGroup, toIndex) => ipcRenderer.invoke('projects:move', key, toGroup, toIndex),
  reorderGroup: (name, toIndex) => ipcRenderer.invoke('projects:reorderGroup', name, toIndex),

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

  // Credentials
  getCredentialStatus: () => ipcRenderer.invoke('credentials:status'),
  saveCredentials: (updates) => ipcRenderer.invoke('credentials:save', updates),
  clearCredential: (key) => ipcRenderer.invoke('credentials:clear', key),
};

contextBridge.exposeInMainWorld('agentSmith', api);

// Notify main that renderer is ready
ipcRenderer.send('renderer:ready');
