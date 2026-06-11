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
  saveJiraIssue: (sessionId, issue) => ipcRenderer.invoke('jira:saveIssue', sessionId, issue),
  clearJiraIssue: (sessionId) => ipcRenderer.invoke('jira:clearIssue', sessionId),

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
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
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
};

contextBridge.exposeInMainWorld('agentSmith', api);

// Notify main that renderer is ready
ipcRenderer.send('renderer:ready');
