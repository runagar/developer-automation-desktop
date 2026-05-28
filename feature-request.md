# New Session hotkey
We need a hotkey to quickly create a new session. 
Pressing Ctrl+N should:
- Open the New Session dropdonw
- Highlight the "New Session" button
  - If the dropdown is opened with a mouse click (existing functionality) the "New Session" button should *not* be highlighted

While the New Session dropdown is open, regardless of if it was opened by clicking the dropdown arrow or pressing Ctrl+N, the following should ALWAYS apply
- Pressing tap/shift+tap should cycle through the dropdown menu, highlighting/un-highlighting each item in turn.
  - The "New Session" button should functionally be the starting point of the list, being incorporated in the tap cycle, like: [{lastItemInDrowdown} -tap-> "New Session" -tap-> "{firstItemInDrowdown}], and vice versa with shift+tap
  - If the dropdown was opened with a mouse click, the first press of tap/shift+tap should highlight {firItemInDropdown} and {lastItemInDropdown}, respectively.
  - If `projects.json` is empty, tapping is a no-op. Highlight should simply be maintained on "New Session"
- Pressing tab/shift+tap to cycle between open sessions should be disabled
- Pressing Enter should activate the highlighted item, just like that highlighted item had been clicked. That means:
  - "New Session" triggers the default workspace session.
  - An item in the list spawns a session for that specific workspace
- Pressing Escape should close the dropdown and un-highlight the highlighted item
  - No focus management, simply drop the focus. 
  - If no item is highlighted, simply close the dropdown. 

# Jira issue overview
We most often work with jira issues. We already MCP servers to enable an agent to fetch a jira issue by its key. 
When an agent is working on a jira issue, we are missing an easy overview of the issue. 
When opening a new session, two taps should be created: 
- **1:** the session cli terminal (existing functionality)
- **2:** A jira overview window (new functionality). 

These tabs should open in the same space, with the terminal in the center and the jira overview window on the right.
The Jira issue overview should have the following data:
- Issue key (e.g. NRPAV-1927)
- Issue summary
- Issue accept criteria (extracted from issue description)
- Issue description (excluding accept criteria)

A user must be able to enter a new issue key in the issue key field.
- If a user enters a key and presses Enter, the issue should be fetched from Jira and the window populated
- If a user enters or edits a key, and clicks away without pressing Enter, the edit should be discarded (no fetching should occur)

In the top right of the Jira window should be a **PLAN** button. Clicking this button should instruct the active agent (in the session CLI interface) to "Fetch issue {key} and make an implementation plan".

# Session workspace handling
We need to be able to manage which session workspaces are available from the application.
Add a button "Manage workspaces".
Clicking this button should open a dialog with a full list of all current workspaces (key → repo → workingDir as defined by `projects.json`)

## Creating new session workspaces
We need to be able to add new workspaces. 
Inside "Manage Workspaces" dialog, add a + button. 
When this button is clicked the user must input: 
- Key; e.g. NRPCON
- Repo; e.g. rs-consent

Clicking "Add" or pressing Enter should add the project to `projects.json`. Key and Repo can be mapped directly. Dir must be "/home/rulu/projects/" + Repo

## Delete session workspace
We need to be able to remove session workspaces
Inside "Manage Workspaces" dialog, add a "x" button (like the one used when closing a cli session)
When clicked, prompt the user to confirm, just like when closing a session. 
The "x" button should be inactive for those workspaces that has an active cli session. 