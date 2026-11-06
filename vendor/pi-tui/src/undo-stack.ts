/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/**
	 * Read-only view of the stored snapshots (oldest first).
	 *
	 * Used by the host layer to keep side data that an undo step can still reach
	 * alive; it never mutates or reorders the stack.
	 */
	snapshots(): readonly S[] {
		return this.stack;
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
