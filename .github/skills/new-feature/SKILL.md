---
name: new-feature
description: Guide for implementing new features end-to-end. Use this when asked to add, build, or implement a feature or when the user references a feature request
allowed-tools: shell
---

1. Checkout main and pull from origin
2. Create a new working branch based on the described feature (e.g. feature/jira-issue-overview)
3. Locate the implementation plan in ./implementation-plans/todo/
7. Review implementation plan again. User might have added things or clarified ambiguities
8. Implement the feature. Do not update ./.github/agent-smith.md at this stage
9. Ask the user to perform manual tests when implemenation is complete
10. Fix any bugs described by the user. Stay on the current working branch. Do not invoke the fix-bug skill.
11. Once testing is complete, update ./.github/agent-smith.md
12. Commit, push to remote, and open a pull request to main
13. NEVER push to remote an open a pull request if user has not confirmed that everything is working as detailed by step 9. and 10.