import React, { useEffect, useRef, useState } from 'react';
import { ProjectEntry, ProjectGroup, Session } from '../../main/types';
import ConfirmDialog from './ConfirmDialog';
import './ManageWorkspacesDialog.css';

interface Props {
  projectGroups: ProjectGroup[];
  sessions: Session[];
  onAdd: (key: string, repo: string, group: string) => Promise<void>;
  onRemove: (key: string) => Promise<void>;
  onAddGroup: (name: string) => Promise<void>;
  onRemoveGroup: (name: string) => Promise<void>;
  onMove: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  onReorderGroup: (name: string, toIndex: number) => Promise<void>;
  onClose: () => void;
}

export default function ManageWorkspacesDialog({
  projectGroups,
  sessions,
  onAdd,
  onRemove,
  onAddGroup,
  onRemoveGroup,
  onMove,
  onReorderGroup,
  onClose,
}: Props): React.ReactElement {
  const [pendingRemoveKey, setPendingRemoveKey] = useState<string | null>(null);

  // Add workspace form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Add group form
  const [showAddGroupForm, setShowAddGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [addGroupError, setAddGroupError] = useState<string | null>(null);
  const [isAddingGroup, setIsAddingGroup] = useState(false);

  // Drag and drop — workspace
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [dropTargetGroup, setDropTargetGroup] = useState<string | null>(null);

  // Drag and drop — group reorder
  const [draggedGroupName, setDraggedGroupName] = useState<string | null>(null);
  const [dropTargetGroupReorder, setDropTargetGroupReorder] = useState<string | null>(null);

  const keyInputRef = useRef<HTMLInputElement>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);
  const groupSelectRef = useRef<HTMLSelectElement>(null);
  const addWorkspaceBtnRef = useRef<HTMLButtonElement>(null);
  const cancelWorkspaceBtnRef = useRef<HTMLButtonElement>(null);
  const groupInputRef = useRef<HTMLInputElement>(null);
  const addGroupBtnRef = useRef<HTMLButtonElement>(null);
  const cancelGroupBtnRef = useRef<HTMLButtonElement>(null);

  // Refs so the Tab handler (registered once) can read current form state
  const showAddFormRef = useRef(false);
  const showAddGroupFormRef = useRef(false);
  useEffect(() => { showAddFormRef.current = showAddForm; }, [showAddForm]);
  useEffect(() => { showAddGroupFormRef.current = showAddGroupForm; }, [showAddGroupForm]);

  useEffect(() => {
    if (showAddForm) keyInputRef.current?.focus();
  }, [showAddForm]);

  useEffect(() => {
    if (showAddGroupForm) groupInputRef.current?.focus();
  }, [showAddGroupForm]);

  // Set default group when form opens or groups change
  useEffect(() => {
    if (showAddForm && !newGroup && projectGroups.length > 0) {
      setNewGroup(projectGroups[0].group);
    }
  }, [showAddForm, projectGroups, newGroup]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendingRemoveKey) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, pendingRemoveKey]);

  // Capture-phase Tab handler: blocks session cycling AND implements
  // focus traps for the add-workspace and add-group forms.
  // Tab flow (add workspace): KEY → REPO → GROUP → ADD → CANCEL → KEY
  // Tab flow (add group):     GROUP NAME → ADD → CANCEL → GROUP NAME
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      e.stopImmediatePropagation(); // always block session cycling

      const focused = document.activeElement;

      if (showAddFormRef.current) {
        const order = [
          keyInputRef,
          repoInputRef,
          groupSelectRef,
          addWorkspaceBtnRef,
          cancelWorkspaceBtnRef,
        ];
        const idx = order.findIndex((r) => r.current === focused);
        if (idx !== -1) {
          e.preventDefault();
          const next = e.shiftKey
            ? order[(idx - 1 + order.length) % order.length]
            : order[(idx + 1) % order.length];
          next.current?.focus();
        }
        return;
      }

      if (showAddGroupFormRef.current) {
        const order = [groupInputRef, addGroupBtnRef, cancelGroupBtnRef];
        const idx = order.findIndex((r) => r.current === focused);
        if (idx !== -1) {
          e.preventDefault();
          const next = e.shiftKey
            ? order[(idx - 1 + order.length) % order.length]
            : order[(idx + 1) % order.length];
          next.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);

  const hasActiveSession = (key: string) =>
    sessions.some((s) => s.project === key && !s.dead);

  // --- Add workspace ---
  const handleAddSubmit = async () => {
    const trimmedKey = newKey.trim().toUpperCase();
    const trimmedRepo = newRepo.trim();
    const trimmedGroup = newGroup.trim();
    if (!trimmedKey || !trimmedRepo) { setAddError('Key and Repo are required'); return; }
    if (!trimmedGroup) { setAddError('Please select a group'); return; }
    const allKeys = projectGroups.flatMap((g) => g.workspaces.map((w) => w.key));
    if (allKeys.includes(trimmedKey)) { setAddError(`Key "${trimmedKey}" already exists`); return; }
    setIsAdding(true);
    setAddError(null);
    try {
      await onAdd(trimmedKey, trimmedRepo, trimmedGroup);
      setNewKey(''); setNewRepo(''); setNewGroup('');
      setShowAddForm(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add workspace');
    } finally {
      setIsAdding(false);
    }
  };

  // --- Add group ---
  const handleAddGroupSubmit = async () => {
    const trimmed = newGroupName.trim().toUpperCase();
    if (!trimmed) { setAddGroupError('Name is required'); return; }
    if (projectGroups.some((g) => g.group === trimmed)) {
      setAddGroupError(`Group "${trimmed}" already exists`); return;
    }
    setIsAddingGroup(true);
    setAddGroupError(null);
    try {
      await onAddGroup(trimmed);
      setNewGroupName('');
      setShowAddGroupForm(false);
    } catch (err) {
      setAddGroupError(err instanceof Error ? err.message : 'Failed to add group');
    } finally {
      setIsAddingGroup(false);
    }
  };

  // --- Drag and drop — workspaces ---
  const handleDragStart = (key: string) => (e: React.DragEvent) => {
    setDraggedKey(key);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedKey(null);
    setDropTargetKey(null);
    setDropTargetGroup(null);
    setDraggedGroupName(null);
    setDropTargetGroupReorder(null);
  };

  const handleDragOverWorkspace = (key: string) => (e: React.DragEvent) => {
    if (draggedGroupName) return; // ignore workspace-row hover during group drag
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetKey(key);
    setDropTargetGroup(null);
  };

  const handleDragOverGroup = (group: string) => (e: React.DragEvent) => {
    if (draggedGroupName) return; // group-name hover is handled separately
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetGroup(group);
    setDropTargetKey(null);
  };

  const handleDropOnWorkspace = (targetKey: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedKey || draggedKey === targetKey) { handleDragEnd(); return; }
    for (const g of projectGroups) {
      const idx = g.workspaces.findIndex((w) => w.key === targetKey);
      if (idx !== -1) {
        await onMove(draggedKey, g.group, idx);
        break;
      }
    }
    handleDragEnd();
  };

  const handleDropOnGroup = (group: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedKey) { handleDragEnd(); return; }
    const target = projectGroups.find((g) => g.group === group);
    if (target) await onMove(draggedKey, group, target.workspaces.length);
    handleDragEnd();
  };

  // --- Drag and drop — group reorder ---
  const handleGroupDragStart = (groupName: string) => (e: React.DragEvent) => {
    e.stopPropagation(); // don't trigger the workspace row drag
    setDraggedGroupName(groupName);
    // Clear workspace drag state so handlers don't mix
    setDraggedKey(null);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleGroupDragOver = (groupName: string) => (e: React.DragEvent) => {
    if (!draggedGroupName || draggedGroupName === groupName) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetGroupReorder(groupName);
    setDropTargetGroup(null);
    setDropTargetKey(null);
  };

  const handleDropOnGroupReorder = (targetGroupName: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedGroupName || draggedGroupName === targetGroupName) { handleDragEnd(); return; }
    const toIndex = projectGroups.findIndex((g) => g.group === targetGroupName);
    if (toIndex !== -1) await onReorderGroup(draggedGroupName, toIndex);
    handleDragEnd();
  };

  const handleDragLeave = () => {
    setDropTargetKey(null);
    setDropTargetGroup(null);
    setDropTargetGroupReorder(null);
  };

  const pendingProject = projectGroups
    .flatMap((g) => g.workspaces)
    .find((w) => w.key === pendingRemoveKey) ?? null;

  return (
    <div className="manage-workspaces-overlay" onClick={onClose}>
      <div
        className="manage-workspaces"
        role="dialog"
        aria-modal="true"
        aria-label="Manage Workspaces"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="manage-workspaces__header">
          <span className="manage-workspaces__title">⬡ MANAGE WORKSPACES</span>
          <button className="btn btn--micro" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="manage-workspaces__body">
          {projectGroups.length === 0 ? (
            <div className="manage-workspaces__empty">No workspaces configured</div>
          ) : (
            <table className="manage-workspaces__table">
              <thead>
                <tr>
                  <th>GROUP</th>
                  <th>KEY</th>
                  <th>REPO</th>
                  <th>DIR</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {projectGroups.map((group) => (
                  group.workspaces.length === 0 ? (
                    // Empty group — droppable placeholder row (workspace drop target)
                    <tr
                      key={`group-empty-${group.group}`}
                      className={[
                        'manage-workspaces__group-empty-row',
                        dropTargetGroup === group.group ? 'manage-workspaces__drop-target-group' : '',
                        dropTargetGroupReorder === group.group ? 'manage-workspaces__drop-target-reorder' : '',
                      ].filter(Boolean).join(' ')}
                      onDragOver={(e) => {
                        handleDragOverGroup(group.group)(e);
                        handleGroupDragOver(group.group)(e);
                      }}
                      onDrop={(e) => {
                        if (draggedGroupName) handleDropOnGroupReorder(group.group)(e);
                        else handleDropOnGroup(group.group)(e);
                      }}
                      onDragLeave={handleDragLeave}
                    >
                      <td className="manage-workspaces__col-group">
                        <span
                          className="manage-workspaces__group-name manage-workspaces__group-drag-handle"
                          draggable
                          onDragStart={handleGroupDragStart(group.group)}
                          onDragEnd={handleDragEnd}
                          title="Drag to reorder group"
                        >{group.group}</span>
                        <button
                          className="btn btn--micro btn--danger manage-workspaces__group-remove"
                          title={`Remove group "${group.group}"`}
                          onClick={() => onRemoveGroup(group.group)}
                        >✕</button>
                      </td>
                      <td colSpan={4} className="manage-workspaces__group-drop-hint">
                        drop here
                      </td>
                    </tr>
                  ) : (
                    group.workspaces.map((w, wi) => {
                      const active = hasActiveSession(w.key);
                      const isFirst = wi === 0;
                      return (
                        <tr
                          key={w.key}
                          className={[
                            'manage-workspaces__row',
                            draggedKey === w.key ? 'manage-workspaces__dragging' : '',
                            dropTargetKey === w.key ? 'manage-workspaces__drop-target' : '',
                            isFirst && dropTargetGroupReorder === group.group ? 'manage-workspaces__drop-target-reorder' : '',
                          ].filter(Boolean).join(' ')}
                          draggable
                          onDragStart={handleDragStart(w.key)}
                          onDragEnd={handleDragEnd}
                          onDragOver={handleDragOverWorkspace(w.key)}
                          onDrop={handleDropOnWorkspace(w.key)}
                          onDragLeave={handleDragLeave}
                        >
                          <td
                            className={[
                              'manage-workspaces__col-group',
                              !isFirst ? 'manage-workspaces__col-group--blank' : '',
                              dropTargetGroup === group.group ? 'manage-workspaces__drop-target-group' : '',
                            ].filter(Boolean).join(' ')}
                            onDragOver={isFirst ? (e) => {
                              handleGroupDragOver(group.group)(e);
                              handleDragOverGroup(group.group)(e);
                            } : undefined}
                            onDrop={isFirst ? (e) => {
                              if (draggedGroupName) handleDropOnGroupReorder(group.group)(e);
                              else handleDropOnGroup(group.group)(e);
                            } : undefined}
                            onDragLeave={isFirst ? handleDragLeave : undefined}
                          >
                            {isFirst && (
                              <span
                                className="manage-workspaces__group-name manage-workspaces__group-drag-handle"
                                draggable
                                onDragStart={handleGroupDragStart(group.group)}
                                onDragEnd={handleDragEnd}
                                title="Drag to reorder group"
                              >{group.group}</span>
                            )}
                          </td>
                          <td className="manage-workspaces__col-key">{w.key}</td>
                          <td className="manage-workspaces__col-repo">{w.repo}</td>
                          <td className="manage-workspaces__col-dir">{w.workingDir}</td>
                          <td className="manage-workspaces__col-actions">
                            <button
                              className="btn btn--micro btn--danger"
                              title={active ? 'Cannot remove — has active session(s)' : `Remove ${w.key}`}
                              disabled={active}
                              onClick={() => setPendingRemoveKey(w.key)}
                            >✕</button>
                          </td>
                        </tr>
                      );
                    })
                  )
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="manage-workspaces__footer">
          <div className="manage-workspaces__footer-row">
            {/* Add group */}
            {!showAddGroupForm ? (
              <button
                className="btn btn--primary manage-workspaces__add-toggle"
                onClick={() => { setShowAddGroupForm(true); setShowAddForm(false); }}
              >
                + ADD GROUP
              </button>
            ) : (
              <div className="manage-workspaces__inline-form">
                <input
                  ref={groupInputRef}
                  className="manage-workspaces__input"
                  placeholder="GROUP NAME"
                  value={newGroupName}
                  onChange={(e) => { setNewGroupName(e.target.value); setAddGroupError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGroupSubmit(); } }}
                  disabled={isAddingGroup}
                />
                <button ref={addGroupBtnRef} className="btn btn--primary" onClick={handleAddGroupSubmit} disabled={isAddingGroup}>
                  {isAddingGroup ? '…' : 'ADD'}
                </button>
                <button ref={cancelGroupBtnRef} className="btn" onClick={() => { setShowAddGroupForm(false); setNewGroupName(''); setAddGroupError(null); }}>
                  CANCEL
                </button>
                {addGroupError && <span className="manage-workspaces__error">{addGroupError}</span>}
              </div>
            )}

            {/* Add workspace */}
            {!showAddForm ? (
              <button
                className="btn btn--primary manage-workspaces__add-toggle"
                onClick={() => { setShowAddForm(true); setShowAddGroupForm(false); }}
              >
                + ADD WORKSPACE
              </button>
            ) : (
              <div className="manage-workspaces__inline-form manage-workspaces__inline-form--wide">
                <input
                  ref={keyInputRef}
                  className="manage-workspaces__input manage-workspaces__input--short"
                  placeholder="KEY"
                  value={newKey}
                  onChange={(e) => { setNewKey(e.target.value); setAddError(null); }}
                  disabled={isAdding}
                />
                <input
                  ref={repoInputRef}
                  className="manage-workspaces__input"
                  placeholder="REPO"
                  value={newRepo}
                  onChange={(e) => { setNewRepo(e.target.value); setAddError(null); }}
                  disabled={isAdding}
                />
                <select
                  ref={groupSelectRef}
                  className="manage-workspaces__select"
                  value={newGroup}
                  onChange={(e) => { setNewGroup(e.target.value); setAddError(null); }}
                  disabled={isAdding}
                >
                  {projectGroups.map((g) => (
                    <option key={g.group} value={g.group}>{g.group}</option>
                  ))}
                </select>
                <button ref={addWorkspaceBtnRef} className="btn btn--primary" onClick={handleAddSubmit} disabled={isAdding}>
                  {isAdding ? '…' : 'ADD'}
                </button>
                <button
                  ref={cancelWorkspaceBtnRef}
                  className="btn"
                  onClick={() => { setShowAddForm(false); setNewKey(''); setNewRepo(''); setAddError(null); }}
                >
                  CANCEL
                </button>
                {addError && <span className="manage-workspaces__error">{addError}</span>}
              </div>
            )}
          </div>

          {newRepo && showAddForm && (
            <div className="manage-workspaces__dir-preview">
              Dir: /home/rulu/projects/{newRepo.trim()}
            </div>
          )}
        </div>
      </div>

      {pendingProject && (
        <ConfirmDialog
          message={`Remove workspace "${pendingProject.key}"?`}
          detail="This will remove the workspace from projects.json. Existing sessions will not be affected."
          confirmLabel="REMOVE"
          onConfirm={async () => {
            await onRemove(pendingProject.key);
            setPendingRemoveKey(null);
          }}
          onCancel={() => setPendingRemoveKey(null)}
        />
      )}
    </div>
  );
}
