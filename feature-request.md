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

In the top right of the Jira window should be a **PLAN** button. Clicking this button should instruct the active agent (in the session CLI interface) to "Fetch {issue-key} and implement it".