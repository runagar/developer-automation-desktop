---
name: new-feature
description: Guide for implementing new features end-to-end. Use this when asked to add, build, or implement a feature or when the user references a feature request
allowed-tools: shell
---

1. Checkout main and pull from origin
3. Review feature-requests.md and locate the feature you've been asked to implement
2. Create a new working branch based on the described feature (e.g. feature/jira-issue-overview)
4. Create a detailed implementation plan. Save it to {feature-name}-implementation-plan.md in ./implementation-plans/
5. Include ambiguities in the implementation plan
6. Wait for user to review the plan and approve
7. Review implementation plan again. User might have added things or clarified ambiguities
8. Implement the feature. Do not update ./.github/agent-smith.md at this stage
9. Ask the user to perform manual tests when implemenation is complete
10. Fix any bugs described by the user. Stay on the current working branch. Do not invoke the fix-bug skill.
11. Once testing is complete, update ./.github/agent-smith.md if required by implemenation-plan
12. Commit, push to remote, and open a pull request to main