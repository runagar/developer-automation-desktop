import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { IpcApi, Session, SessionState, ProjectEntry } from '../main/types';

const api: IpcApi = {
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  destroySession: (id) => ipcRenderer.invoke('sessions:destroy', id),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
  reviveSession: (id) => ipcRenderer.invoke('sessions:revive', id),

  ptyWrite: (sessionId, data) => ipcRenderer.invoke('pty:write', sessionId, data),
  ptyResize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),

  getProjects: () => ipcRenderer.invoke('projects:get'),

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
};

contextBridge.exposeInMainWorld('agentSmith', api);

// Notify main that renderer is ready
ipcRenderer.send('renderer:ready');
