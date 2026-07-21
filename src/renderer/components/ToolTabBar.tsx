import React from 'react';
import { TOOL_TABS, ToolTabId } from '../dashboard/layout';
import { useLayoutStore } from '../stores/layoutStore';
import SettingsMenu from './SettingsMenu';
import './ToolTabBar.css';

interface Props {
  onOpenWorkspaces: () => void;
  onOpenJira: () => void;
  onOpenNotes: () => void;
}

export default function ToolTabBar({ onOpenWorkspaces, onOpenJira, onOpenNotes }: Props): React.ReactElement {
  const activeTab = useLayoutStore((s) => s.activeTab);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);

  return (
    <div className="tool-tab-bar">
      <div className="tool-tab-bar__tabs">
        {TOOL_TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              className={`tool-tab-bar__tab ${isActive ? 'tool-tab-bar__tab--active' : 'tool-tab-bar__tab--inactive'}`}
              tabIndex={-1}
              onClick={() => setActiveTab(tab.id as ToolTabId)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="tool-tab-bar__right">
        <SettingsMenu
          onOpenWorkspaces={onOpenWorkspaces}
          onOpenJira={onOpenJira}
          onOpenNotes={onOpenNotes}
        />
      </div>
    </div>
  );
}
