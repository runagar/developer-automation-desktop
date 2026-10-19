import { useEffect, useMemo, useReducer } from 'react';
import { DiffHunk } from '../../main/githubDiff';
import { DiffSyntax, highlightDiff, loadDiffParser, peekDiffParser } from '../utils/diffSyntax';

export function useDiffSyntax(path: string, hunks: DiffHunk[]): DiffSyntax | null {
  const diffParser = peekDiffParser(path);
  const [, languageLoaded] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (diffParser !== undefined) return undefined;
    let cancelled = false;
    void loadDiffParser(path).then(() => {
      if (!cancelled) languageLoaded();
    });
    return () => { cancelled = true; };
  }, [path, diffParser]);

  return useMemo(() => (diffParser ? highlightDiff(hunks, diffParser) : null), [hunks, diffParser]);
}
