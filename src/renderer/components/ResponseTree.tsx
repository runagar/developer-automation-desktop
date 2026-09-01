import React from 'react';
import { cn } from '../utils/cn';
import { TreeRow } from '../stores/responseTree';

interface Props {
  rows: TreeRow[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onFollowLink: (url: string) => void;
}

/** How a collapsed container hints at what it holds. */
function summaryOf(row: TreeRow): string {
  if (row.kind === 'array') return `[${row.childCount}]`;
  if (row.kind === 'object') return `{${row.childCount}}`;
  return '';
}

/**
 * Renders the flattened JSON tree.
 *
 * Rows arrive already flattened, so striping follows *visible* order and stays
 * correct as nodes are expanded and collapsed.
 */
export default function ResponseTree({
  rows, expanded, onToggle, onFollowLink,
}: Props): React.ReactElement {
  return (
    <div className="rest-response-pane__tree">
      {rows.map((row, index) => {
        const expandable = row.kind === 'object' || row.kind === 'array';
        const isOpen = expandable && expanded.has(row.id);

        return (
          <div
            key={row.id}
            className={cn(
              'rest-response-pane__row',
              index % 2 === 1 && 'rest-response-pane__row--alt',
              expandable && 'rest-response-pane__row--expandable',
            )}
            // The whole row toggles, not just the marker (requirement 2.2.2.3-4).
            onClick={expandable ? () => onToggle(row.id) : undefined}
            style={{ paddingLeft: `${8 + row.depth * 16}px` }}
          >
            {expandable && (
              <span className="rest-response-pane__marker">{isOpen ? '-' : '+'}</span>
            )}
            {row.label && <span className="rest-response-pane__key">{row.label}</span>}

            {row.kind === 'scalar' && (
              row.isLink ? (
                <button
                  className="rest-response-pane__link"
                  // The row's own click would toggle nothing here, but stopping
                  // it keeps a future expandable-link case honest.
                  onClick={(e) => { e.stopPropagation(); onFollowLink(row.value ?? ''); }}
                  title={`Send a GET to ${row.value}`}
                >
                  {row.value}
                </button>
              ) : (
                <span className="rest-response-pane__value">{row.value}</span>
              )
            )}

            {row.kind === 'empty' && (
              <span className="rest-response-pane__value">{row.value}</span>
            )}

            {expandable && !isOpen && (
              <span className="rest-response-pane__count">{summaryOf(row)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
