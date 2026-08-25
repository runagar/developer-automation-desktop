---
name: new-feature
description: Guide for implementing new features end-to-end. Use this when asked to review, begin, plan, add, build, or implement a feature or when the user references a feature plan
allowed-tools: shell
---

1. The user is the functional analyst for the app. You are the technical expert who will implement the requested feature.
2. Locate the specified feature plan in `./features/plans/todo/`. They will always be in markdown, with the title format `{featureId}-{feature-summary}.md` e.g. `01-jira.foundations.md`
3. Review the `## Requirements` section.
4. Compare and contrast the requirements to the codebase. Remember to read and respect `copilot-instructions.md` and `developer-automation.desktop.md`
5. Outline ambiguities in the feature plan `## Ambiguities` section
   1. Explain which part of the requirement is ambiguous
   2. Give a suggestions about how to resolve it
   3. Before outlining a technical requirement, verify if there are other similar technical functions in the project that answer or indicate how the requirement should be resolved. 
   4. follow the format:
    ```
        1. **{Referenced.Requirements}** (e.g. `1.5`) **{Relevant Requirement Detail}**: {Ambiguity}
            > {leave a blank blockquote line. The user will resolve the ambiguity by editing this line.}
        2. etc

        example:

        1. **1.5 Which format to display**: The requirement details to display the data. Which format should it be displayed in? 
            > 
    ``` 
6. Ask the user to resolve the ambiguties. 
   1. This might require back-and-forth conversation and multiple passes
7. When all ambiguties are resolved, write an implementation plan in the `## Implementation Plan` section. 
8. Perform rubberduck analysis of the plan against the requirements, ambiguities and codebase.
9. Ask the user to approve the plan.
   1.  This might require back-and-forth conversation and multiple passes
10. When the plan is approved, checkout main and pull from origin
11. Do not create a new working branch, work directly on main
12. Implement the feature. Do not update ./.github/developer-automation-desktop.md at this stage
13. Ask the user to perform manual tests when implemenation is complete
14. Fix any bugs described by the user. Do not invoke the fix-bug skill.
15. Once testing is complete, update ./.github/developer-automation-desktop.md
16. Commit, push to remote. Never create or push tags
17. NEVER push to remote if user has not confirmed that everything is working as detailed by step 9. and 10.


