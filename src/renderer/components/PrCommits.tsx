import React from 'react';
import { ClipboardCopy } from 'lucide-react';
import { PrCommit } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { relativeTime } from '../utils/relativeTime';

interface Props {
  commits: PrCommit[];
}

function CommitRow({ commit }: { commit: PrCommit }): React.ReactElement {
  const openDiffFor = useGitHubStore((s) => s.openDiffFor);

  return (
    <div className="pr-commits__row">
      <button
        className="pr-commits__copy"
        title="Copy commit hash"
        // Chromium focuses a clicked button regardless of tab index. Letting
        // focus land here would clear the panel's focus tracking and silently
        // disable Tab navigation — the same trap as the session list's ✕.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => window.dad.clipboardWrite(commit.oid)}
      >
        {/* Sized to match the chevrons in the diff file tree and the API
            Picker's section headers. */}
        <ClipboardCopy size={12} />
      </button>
      <button
        className="pr-commits__hash"
        title="Show this commit's diff"
        onClick={() => openDiffFor({ kind: 'commit', oid: commit.oid, abbreviatedOid: commit.abbreviatedOid })}
      >
        {commit.abbreviatedOid}
      </button>
      <div className="pr-commits__text">
        {/* Headline only — the full body belongs in the diff view, not here. */}
        <div className="pr-commits__headline">{commit.messageHeadline}</div>
        <div className="pr-commits__byline">
          {commit.author ?? 'unknown'} · {relativeTime(commit.committedDate)}
        </div>
      </div>
    </div>
  );
}

/** Every commit in the pull request (requirement 3.2.2). */
export default function PrCommits({ commits }: Props): React.ReactElement {
  if (commits.length === 0) {
    return <div className="pr-commits__none">No commits</div>;
  }

  return (
    <div className="pr-commits">
      {commits.map((commit) => <CommitRow key={commit.oid} commit={commit} />)}
    </div>
  );
}
