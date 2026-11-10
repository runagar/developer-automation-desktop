import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { notesWrapDecorations } from './notesWrapping';

describe('notesWrapDecorations', () => {
  it('aligns continuations with leading spaces without changing the document', () => {
    // Given
    const doc = '    An indented paragraph that wraps';
    const state = EditorState.create({ doc });
    // When
    const decorations = notesWrapDecorations(state, [{ from: 0, to: doc.length }]);
    // Then
    expect(decorations.iter().value?.spec.attributes.style).toBe(
      'padding-left: calc(6px + 4ch); text-indent: -4ch;',
    );
    expect(state.doc.toString()).toBe(doc);
  });

  it('counts tabs and mixed whitespace using the configured tab stops', () => {
    // Given
    const state = EditorState.create({
      doc: ' \t  Indented text',
      extensions: [EditorState.tabSize.of(4)],
    });
    // When
    const decorations = notesWrapDecorations(state, [{ from: 0, to: state.doc.length }]);
    // Then
    expect(decorations.iter().value?.spec.attributes.style).toBe(
      'padding-left: calc(6px + 6ch); text-indent: -6ch;',
    );
  });

  it('leaves unindented and whitespace-only lines alone', () => {
    // Given
    const state = EditorState.create({ doc: 'Plain text\n\n  \t\nAnother paragraph' });
    // When
    const decorations = notesWrapDecorations(state, [{ from: 0, to: state.doc.length }]);
    // Then
    expect(decorations.size).toBe(0);
  });

  it('handles partial visible lines without decorating a line twice', () => {
    // Given
    const state = EditorState.create({ doc: '  First paragraph\n    Second paragraph\n  Offscreen' });
    const second = state.doc.line(2);
    // When
    const decorations = notesWrapDecorations(state, [
      { from: 3, to: 7 },
      { from: 8, to: second.to },
    ]);
    // Then
    expect(decorations.size).toBe(2);
    const cursor = decorations.iter();
    expect(cursor.from).toBe(0);
    cursor.next();
    expect(cursor.from).toBe(second.from);
    expect(cursor.value?.spec.attributes.style).toContain('4ch');
  });

  it('updates the indentation after whitespace is edited or removed', () => {
    // Given
    const state = EditorState.create({ doc: '    Paragraph' });
    // When
    const edited = state.update({ changes: { from: 0, to: 2 } }).state;
    const unindented = edited.update({ changes: { from: 0, to: 2 } }).state;
    // Then
    expect(notesWrapDecorations(edited, [{ from: 0, to: edited.doc.length }])
      .iter().value?.spec.attributes.style).toContain('2ch');
    expect(notesWrapDecorations(unindented, [{ from: 0, to: unindented.doc.length }]).size).toBe(0);
  });
});
