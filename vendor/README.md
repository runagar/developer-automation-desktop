# Jira Tools dependency

`rulu-jira-tools-0.1.0.tgz` is the built release artifact from the standalone `jira-tools` project. DAD installs this versioned tarball, not a sibling checkout, global installation, or development symlink. The lockfile pins its integrity. The CLI is installed separately from the identical artifact and does not require DAD to run.

To update, test and version Jira Tools, build its release with `npm pack`, copy the resulting tarball into this directory, and run `npm install --ignore-scripts ./vendor/<artifact>.tgz` in DAD. Update the globally installed CLI with that same artifact and rerun DAD's tests, typecheck, and build. Never include credentials in a release artifact.
