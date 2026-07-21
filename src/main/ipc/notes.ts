import { IpcMain, BrowserWindow, dialog } from 'electron';
import { NotesManager, NotesScope } from '../notes';

export function registerNotesHandlers(
  ipcMain: IpcMain,
  notesManager: NotesManager,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle('notes:createPanel', (_event, scope: NotesScope, panelId?: string) => notesManager.createPanel(scope, panelId));
  ipcMain.handle('notes:closePanel', (_event, panelId: string) => notesManager.closePanel(panelId));
  ipcMain.handle('notes:destroyPanel', (_event, panelId: string) => notesManager.destroyPanel(panelId));
  ipcMain.handle('notes:restorePanel', (_event, panelId: string) => notesManager.restorePanel(panelId));
  ipcMain.handle('notes:getClosedPanels', () => notesManager.getClosedGlobalPanels());
  ipcMain.handle('notes:getAllGlobalPanels', () => notesManager.getAllGlobalPanels());
  ipcMain.handle('notes:renamePanel', (_event, panelId: string, name: string) => notesManager.renamePanel(panelId, name));
  ipcMain.handle('notes:createTab', (_event, scope: NotesScope) => notesManager.createTab(scope));
  ipcMain.handle('notes:closeTab', (_event, tabId: string) => notesManager.closeTab(tabId));
  ipcMain.handle('notes:restoreTab', (_event, tabId: string) => notesManager.restoreTab(tabId));
  ipcMain.handle('notes:getClosedTabs', (_event, scope: NotesScope) => notesManager.getClosedTabs(scope));
  ipcMain.handle('notes:renameTab', (_event, tabId: string, name: string) => notesManager.renameTab(tabId, name));
  ipcMain.handle('notes:saveContent', (_event, tabId: string, content: string) => notesManager.saveTabContent(tabId, content));
  ipcMain.handle('notes:loadContent', (_event, tabId: string) => notesManager.loadTabContent(tabId));
  ipcMain.handle('notes:getTabs', (_event, scope: NotesScope) => notesManager.getOpenTabs(scope));
  ipcMain.handle('notes:exportTab', async (_event, tabId: string) => {
    const win = getWindow();
    if (!win) return false;
    const filePath = notesManager.getTabFilePath(tabId);
    if (!filePath) return false;
    const defaultName = `${tabId}.md`;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    notesManager.exportTab(tabId, result.filePath);
    return true;
  });
  ipcMain.handle('notes:copyRef', (_event, tabId: string) => notesManager.getTabFilePath(tabId));
}
