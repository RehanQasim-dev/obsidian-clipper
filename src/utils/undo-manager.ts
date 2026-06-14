// Unified, chronological undo/redo across all annotation types (highlights,
// comments, and pencil strokes). Each subsystem pushes an UndoEntry describing
// how to revert and re-apply one action; Ctrl+Z / Ctrl+Shift+Z (wired globally
// in content.ts) pop the most recent entry across every subsystem, so undo
// always reverts the user's last action regardless of which tool produced it.
//
// Entries are opaque closures — the manager never inspects the data, it just
// calls undo()/redo(). This keeps highlights and pencil decoupled while sharing
// one stack.

export interface UndoEntry {
	undo: () => void;
	redo: () => void;
}

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const MAX_HISTORY_LENGTH = 60;

// Notified after any change so UI affordances (e.g. the highlighter menu's
// undo/redo buttons) can refresh their enabled state.
const changeListeners: Array<() => void> = [];

export function onUndoHistoryChange(listener: () => void): void {
	changeListeners.push(listener);
}

function notifyChange(): void {
	changeListeners.forEach(fn => fn());
}

export function pushUndo(entry: UndoEntry): void {
	undoStack.push(entry);
	if (undoStack.length > MAX_HISTORY_LENGTH) undoStack.shift();
	// Any fresh action invalidates the redo branch.
	redoStack.length = 0;
	notifyChange();
}

export function undoLast(): boolean {
	const entry = undoStack.pop();
	if (!entry) return false;
	entry.undo();
	redoStack.push(entry);
	notifyChange();
	return true;
}

export function redoLast(): boolean {
	const entry = redoStack.pop();
	if (!entry) return false;
	entry.redo();
	undoStack.push(entry);
	notifyChange();
	return true;
}

export function canUndo(): boolean {
	return undoStack.length > 0;
}

export function canRedo(): boolean {
	return redoStack.length > 0;
}

export function clearUndoHistory(): void {
	undoStack.length = 0;
	redoStack.length = 0;
	notifyChange();
}
