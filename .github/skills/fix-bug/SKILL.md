---
name: fix-bug
description: Guide for fixing bugs in existing functionality. Use this when asked to fix, diagnose or debug a bug that is not related to implementation of new features
allowed-tools: shell
---

1. Checkout main and pull from origin
2. Create a new working branch based on described issue (e.g. bugfix/enter-key-not-working-in-confirmation-dialog)
3. Investigate the codebase to locate the issue. If the issue cannot be determined, document findings and ask the user for more context. 
4. Fix the issue
5. Ask the user to test the bugfix
6. Repeat from step 3. if issue persists
7. When confirmed fixed, update ./.github/agent-smith.md if necessary
8. Commit to working branch, push to remote, and open a pull request to main