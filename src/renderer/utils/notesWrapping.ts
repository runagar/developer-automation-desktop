import { countColumn, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

export function notesWrapDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLineFrom = -1;
  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      if (line.from > lastLineFrom) {
        const whitespace = /^[ \t]+/.exec(line.text)?.[0];
        if (whitespace && whitespace.length < line.length) {
          const columns = countColumn(whitespace, state.tabSize);
          builder.add(line.from, line.from, Decoration.line({
            attributes: {
              style: `padding-left: calc(6px + ${columns}ch); text-indent: -${columns}ch;`,
            },
          }));
        }
        lastLineFrom = line.from;
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const notesWrapping = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = notesWrapDecorations(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) {
      this.decorations = notesWrapDecorations(update.state, update.view.visibleRanges);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
