// containerTree.js

export class ContainerTree {
    constructor() {
        this._roots = new Map();
        this._pendingSplitDirection = new Map();
        this._nodeCounter = 0;
    }

    _generateId() {
        return `node-${++this._nodeCounter}`;
    }

    _makeLeaf(window, ratio = 1) {
        return { type: 'leaf', id: this._generateId(), window, ratio, savedRatio: null };
    }

    _makeContainer(direction, children, ratio = 1) {
        return { type: 'container', id: this._generateId(), direction, children, ratio, savedRatio: null };
    }

    getRoot(wsIndex) {
        if (!this._roots.has(wsIndex)) {
            this._roots.set(wsIndex, this._makeContainer('horizontal', []));
        }
        return this._roots.get(wsIndex);
    }

    setPendingSplit(wsIndex, direction) {
        this._pendingSplitDirection.set(wsIndex, direction);
    }

    getPendingSplit(wsIndex) {
        return this._pendingSplitDirection.get(wsIndex) ?? 'horizontal';
    }

    clearPendingSplit(wsIndex) {
        this._pendingSplitDirection.delete(wsIndex);
    }

    findLeaf(window, node = null, wsIndex = null) {
        const root = node ?? this.getRoot(wsIndex);
        if (root.type === 'leaf') return root.window === window ? root : null;
        for (const child of root.children) {
            const found = this.findLeaf(window, child);
            if (found) return found;
        }
        return null;
    }

    findParent(nodeId, current = null, wsIndex = null) {
        const root = current ?? this.getRoot(wsIndex);
        if (root.type === 'leaf') return null;
        for (const child of root.children) {
            if (child.id === nodeId) return root;
            const found = this.findParent(nodeId, child);
            if (found) return found;
        }
        return null;
    }

    findNodeById(id, node) {
        if (node.id === id) return node;
        if (node.type === 'leaf') return null;
        for (const child of node.children) {
            const found = this.findNodeById(id, child);
            if (found) return found;
        }
        return null;
    }

    getWindows(wsIndex) {
        const results = [];
        this._collectLeaves(this.getRoot(wsIndex), results);
        return results;
    }

    _collectLeaves(node, results) {
        if (node.type === 'leaf') {
            // Only include visible leaves (ratio > 0)
            if (node.ratio > 0) results.push(node.window);
            return;
        }
        for (const child of node.children) {
            this._collectLeaves(child, results);
        }
    }

    insertWindow(window, wsIndex, focusedWindow = null) {
        const root = this.getRoot(wsIndex);
        const newLeaf = this._makeLeaf(window);

        if (root.children.length === 0) {
            newLeaf.ratio = 1;
            root.children.push(newLeaf);
            return;
        }

        const hasPendingSplit = this._pendingSplitDirection.has(wsIndex);

        if (!hasPendingSplit) {
            const focusedLeaf = focusedWindow ? this.findLeaf(focusedWindow, root) : null;
            const parent = focusedLeaf
                ? (this.findParent(focusedLeaf.id, root) ?? root)
                : root;

            const insertIdx = focusedLeaf
                ? parent.children.indexOf(focusedLeaf) + 1
                : parent.children.length;

            if (focusedLeaf) {
                // Take half of focused window's ratio
                const half = focusedLeaf.ratio / 2;
                focusedLeaf.ratio = half;
                newLeaf.ratio = half;
            } else {
                // No focused window — distribute equally among all visible
                const visible = parent.children.filter(c => c.ratio > 0);
                const equal = 1 / (visible.length + 1);
                visible.forEach(c => c.ratio = equal);
                newLeaf.ratio = equal;
            }

            parent.children.splice(insertIdx, 0, newLeaf);
        } else {
            // User set split direction — create nested container in focused window's slot
            const splitDirection = this.getPendingSplit(wsIndex);
            this.clearPendingSplit(wsIndex);

            const focusedLeaf = focusedWindow ? this.findLeaf(focusedWindow, root) : null;

            if (!focusedLeaf) {
                const visible = root.children.filter(c => c.ratio > 0);
                if (visible.length === 0) {
                    newLeaf.ratio = 1;
                } else {
                    const lastVisible = visible[visible.length - 1];
                    const half = lastVisible.ratio / 2;
                    lastVisible.ratio = half;
                    newLeaf.ratio = half;
                }
                root.children.push(newLeaf);
                return;
            }

            const parent = this.findParent(focusedLeaf.id, root) ?? root;
            const insertIdx = parent.children.indexOf(focusedLeaf) + 1;

            if (parent.direction === splitDirection) {
                // Parent already has the same direction — add as sibling after focused leaf
                const visible = parent.children.filter(c => c.ratio > 0);
                const equal = 1 / (visible.length + 1);
                visible.forEach(c => c.ratio = equal);
                newLeaf.ratio = equal;
                parent.children.splice(insertIdx, 0, newLeaf);
            } else {
                const containerRatio = focusedLeaf.ratio;
                const focusedIdx = parent.children.indexOf(focusedLeaf);

                focusedLeaf.ratio = 0.5;
                focusedLeaf.savedRatio = null;
                newLeaf.ratio = 0.5;

                const newContainer = this._makeContainer(splitDirection, [
                    focusedLeaf,
                    newLeaf,
                ], containerRatio);

                parent.children[focusedIdx] = newContainer;
            }
        }
    }

    removeWindow(window, wsIndex) {
        const root = this.getRoot(wsIndex);
        const leaf = this.findLeaf(window, root);
        if (!leaf) return;
        this._removeLeaf(leaf, root);
    }

    _removeLeaf(leaf, root) {
        const parent = this.findParent(leaf.id, root);
        if (!parent) {
            const idx = root.children.indexOf(leaf);
            if (idx === -1) return;
            root.children.splice(idx, 1);
            this._redistributeRatios(root);
            console.log(`[Tree] after remove from root: ${JSON.stringify(root.children.map(c => ({ id: c.id, ratio: c.ratio })))}`);
            return;
        }
        const idx = parent.children.indexOf(leaf);
        parent.children.splice(idx, 1);
        console.log(`[Tree] after splice: ${JSON.stringify(parent.children.map(c => ({ id: c.id, ratio: c.ratio })))}`);
        if (parent.children.length === 0) {
            this._removeNode(parent, root);
        } else if (parent.children.length === 1) {
            this._collapseContainer(parent, root);
        } else {
            this._redistributeRatios(parent);
            console.log(`[Tree] after redistribute: ${JSON.stringify(parent.children.map(c => ({ id: c.id, ratio: c.ratio })))}`);
        }
    }

    _removeNode(node, root) {
        const parent = this.findParent(node.id, root);
        if (!parent) return;

        const idx = parent.children.indexOf(node);
        parent.children.splice(idx, 1);

        if (parent.children.length === 0) {
            this._removeNode(parent, root);
        } else if (parent.children.length === 1) {
            this._collapseContainer(parent, root);
        } else {
            this._redistributeRatios(parent);
        }
    }

    _collapseContainer(container, root) {
        const onlyChild = container.children[0];

        if (onlyChild.type === 'container') {
            // Container child — always safe to inherit ratio
            onlyChild.ratio = container.ratio;
            onlyChild.savedRatio = container.savedRatio;
        } else {
            // Leaf child — check if it's collapsed
            if (onlyChild.ratio === 0) {
                // Child is collapsed (maximized/minimized) — update savedRatio not ratio
                // so when it restores it gets the correct space
                onlyChild.savedRatio = container.ratio;
            } else {
                onlyChild.ratio = container.ratio;
            }
        }

        const parent = this.findParent(container.id, root);
        if (!parent) {
            if (onlyChild.type === 'container') {
                root.direction = onlyChild.direction;
                root.children = onlyChild.children;
            }
            return;
        }

        const idx = parent.children.indexOf(container);
        parent.children[idx] = onlyChild;
    }

    _redistributeRatios(container) {
        const visible = container.children.filter(c => c.ratio > 0);
        if (visible.length === 0) return;
        const total = visible.reduce((sum, c) => sum + c.ratio, 0);
        if (total === 0) {
            const equal = 1 / visible.length;
            visible.forEach(c => c.ratio = equal);
        } else {
            visible.forEach(c => c.ratio = c.ratio / total);
        }
    }

    /**
     * Collapse a node (window hidden — minimized or maximized).
     * Sets ratio to 0, saves old ratio, propagates up if needed.
     */
    collapseNode(window, wsIndex) {
        const root = this.getRoot(wsIndex);
        const leaf = this.findLeaf(window, root);
        if (!leaf) return;
        if (leaf.ratio === 0) return;

        // Save only own ratio
        leaf.savedRatio = leaf.ratio;
        leaf.ratio = 0;

        // Redistribute freed space proportionally among visible siblings
        const parent = this.findParent(leaf.id, root) ?? root;
        const visible = parent.children.filter(c => c.ratio > 0);
        const total = visible.reduce((sum, c) => sum + c.ratio, 0);

        if (total > 0) {
            visible.forEach(c => c.ratio = c.ratio / total);
        } else {
            const equal = 1 / visible.length;
            visible.forEach(c => c.ratio = equal);
        }

        this._propagateCollapseUp(leaf.id, root);
    }

    _propagateCollapseUp(nodeId, root) {
        const parent = this.findParent(nodeId, root);
        if (!parent) return;

        const allZero = parent.children.every(c => c.ratio === 0);
        if (allZero) {
            if (parent.ratio > 0) {
                parent.savedRatio = parent.ratio;
            }
            parent.ratio = 0;
            this._propagateCollapseUp(parent.id, root);
        }
    }

    /**
     * Restore a node (window returning from minimized/maximized).
     * Walks up restoring savedRatios, renormalizes at each level.
     */
    restoreNode(window, wsIndex) {
        const root = this.getRoot(wsIndex);
        const leaf = this.findLeaf(window, root);
        if (!leaf) return;
        if (leaf.savedRatio === null || leaf.savedRatio === undefined) return;

        this._restoreAncestors(leaf.id, root);

        const parent = this.findParent(leaf.id, root) ?? root;
        const savedRatio = leaf.savedRatio;

        leaf.ratio = savedRatio;
        leaf.savedRatio = null;

        const visible = parent.children.filter(c => c.ratio > 0 && c !== leaf);

        if (visible.length === 0) {
            leaf.ratio = 1;
            return;
        }

        // Check if ratios would go negative after restore
        const visibleTotal = visible.reduce((sum, c) => sum + c.ratio, 0);
        const remainingSpace = 1 - savedRatio;

        if (remainingSpace <= 0) {
            // savedRatio is too large — clamp to equal share
            const equal = 1 / (visible.length + 1);
            leaf.ratio = equal;
            visible.forEach(c => c.ratio = equal);
            return;
        }

        if (visibleTotal <= 0) {
            const equal = remainingSpace / visible.length;
            visible.forEach(c => c.ratio = equal);
            return;
        }

        visible.forEach(c => c.ratio = remainingSpace * (c.ratio / visibleTotal));
    }

    _restoreAncestors(nodeId, root) {
        const parent = this.findParent(nodeId, root);
        if (!parent) return;

        // Recurse up first
        this._restoreAncestors(parent.id, root);

        // Restore this parent if it was zeroed
        if (parent.ratio === 0 && parent.savedRatio !== null) {
            parent.ratio = parent.savedRatio;
            parent.savedRatio = null;

            // Renormalize grandparent
            const grandparent = this.findParent(parent.id, root);
            if (grandparent) this._renormalizeContainer(grandparent);
        }
    }

    _renormalizeContainer(container) {
        const visible = container.children.filter(c => c.ratio > 0);
        if (visible.length === 0) return;
        const total = visible.reduce((sum, c) => sum + c.ratio, 0);
        if (total === 0) return;
        visible.forEach(c => c.ratio = c.ratio / total);
    }

    moveToWorkspace(window, fromWsIndex, toWsIndex) {
        this.removeWindow(window, fromWsIndex);
        this.insertWindow(window, toWsIndex, null);
    }

    clearWorkspace(wsIndex) {
        this._roots.delete(wsIndex);
        this._pendingSplitDirection.delete(wsIndex);
    }

    swapWindows(windowA, windowB, wsIndex) {
        const root = this.getRoot(wsIndex);
        const leafA = this.findLeaf(windowA, root);
        const leafB = this.findLeaf(windowB, root);
        console.log(`[Tiler] swapWindows: leafA=${!!leafA} leafB=${!!leafB}`);
        if (!leafA || !leafB) return;
        leafA.window = windowB;
        leafB.window = windowA;
        console.log(`[Tiler] swapWindows: done`);
    }

    insertWindowRelativeTo(windowToMove, targetWindow, position, wsIndex) {
        // position: 'before' | 'after' | 'above' | 'below'
        const root = this.getRoot(wsIndex);

        // Remove window from its current position
        const movingLeaf = this.findLeaf(windowToMove, root);
        if (!movingLeaf) return;

        // Save ratio before removal
        const savedRatio = movingLeaf.ratio;
        this.removeWindow(windowToMove, wsIndex);

        // Find target after removal (tree may have changed)
        const targetLeaf = this.findLeaf(targetWindow, root);
        if (!targetLeaf) return;

        const targetParent = this.findParent(targetLeaf.id, root) ?? root;
        const targetIdx = targetParent.children.indexOf(targetLeaf);

        const isHorizontal = position === 'before' || position === 'after';
        const requiredDirection = isHorizontal ? 'horizontal' : 'vertical';

        const newLeaf = this._makeLeaf(windowToMove, 0);
        newLeaf.ratio = savedRatio;

        if (targetParent.direction === requiredDirection) {
            // Insert into same container
            const insertIdx = position === 'after' || position === 'below'
                ? targetIdx + 1
                : targetIdx;

            // Give new leaf half of target's ratio
            const half = targetLeaf.ratio / 2;
            targetLeaf.ratio = half;
            newLeaf.ratio = half;

            targetParent.children.splice(insertIdx, 0, newLeaf);
        } else {
            // Create container with correct ratio
            const containerRatio = targetLeaf.ratio;
            const newContainer = this._makeContainer(requiredDirection, [], containerRatio);

            // Modify targetLeaf in place — preserves all external references
            targetLeaf.ratio = 0.5;
            targetLeaf.savedRatio = null;
            newLeaf.ratio = 0.5;

            if (position === 'after' || position === 'below') {
                newContainer.children = [targetLeaf, newLeaf];
            } else {
                newContainer.children = [newLeaf, targetLeaf];
            }

            // Replace targetLeaf's slot in parent with newContainer
            targetParent.children[targetIdx] = newContainer;
        }

    }
}