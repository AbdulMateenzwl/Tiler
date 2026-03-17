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
            // Default — add as sibling in focused window's parent container
            const focusedLeaf = focusedWindow ? this.findLeaf(focusedWindow, root) : null;
            const parent = focusedLeaf
                ? (this.findParent(focusedLeaf.id, root) ?? root)
                : root;

            // Insert after focused leaf
            const insertIdx = focusedLeaf
                ? parent.children.indexOf(focusedLeaf) + 1
                : parent.children.length;

            parent.children.splice(insertIdx, 0, newLeaf);

            // Redistribute equally among visible siblings
            const visible = parent.children.filter(c => c.ratio > 0);
            const equal = 1 / visible.length;
            visible.forEach(c => c.ratio = equal);

        } else {
            // User set split direction — create nested container in focused window's slot
            const splitDirection = this.getPendingSplit(wsIndex);
            this.clearPendingSplit(wsIndex);

            const focusedLeaf = focusedWindow ? this.findLeaf(focusedWindow, root) : null;

            if (!focusedLeaf) {
                // No focused leaf — just append to root
                root.children.push(newLeaf);
                const visible = root.children.filter(c => c.ratio > 0);
                const equal = 1 / visible.length;
                visible.forEach(c => c.ratio = equal);
                return;
            }

            const parent = this.findParent(focusedLeaf.id, root);
            if (!parent) return;

            const idx = parent.children.indexOf(focusedLeaf);

            // Replace focused leaf with a new container of the requested direction
            const newContainer = this._makeContainer(splitDirection, [
                { ...focusedLeaf, ratio: 0.5, savedRatio: null },
                { ...newLeaf, ratio: 0.5 },
            ], focusedLeaf.ratio);

            parent.children[idx] = newContainer;
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
            return;
        }

        const idx = parent.children.indexOf(leaf);
        parent.children.splice(idx, 1);

        if (parent.children.length === 0) {
            this._removeNode(parent, root);
        } else if (parent.children.length === 1) {
            this._collapseContainer(parent, root);
        } else {
            this._redistributeRatios(parent);
        }
    }

    _removeNode(node, root) {
        const parent = this.findParent(node.id, root);
        if (!parent) return;

        const idx = parent.children.indexOf(node);
        parent.children.splice(idx, 1);

        if (parent.children.length === 1) {
            this._collapseContainer(parent, root);
        } else {
            this._redistributeRatios(parent);
        }
    }

    _collapseContainer(container, root) {
        const onlyChild = container.children[0];
        onlyChild.ratio = container.ratio;

        const parent = this.findParent(container.id, root);
        if (!parent) return;

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
        console.log(`[Tiler] collapseNode: "${window.get_title()}" leaf found=${!!leaf} ratio=${leaf?.ratio}`);
        if (!leaf) return;

        const parent = this.findParent(leaf.id, root) ?? root;

        // Save ALL siblings ratios before collapsing
        leaf.savedRatio = leaf.ratio;
        leaf._siblingRatiosSnapshot = parent.children.map(c => ({
            id: c.id,
            ratio: c.ratio
        }));

        leaf.ratio = 0;

        // Redistribute visible siblings proportionally
        const visible = parent.children.filter(c => c.ratio > 0);
        const totalVisible = visible.reduce((sum, c) => sum + c.ratio, 0);
        if (totalVisible > 0) {
            visible.forEach(c => c.ratio = c.ratio / totalVisible);
        }

        // Propagate up if needed
        this._propagateCollapseUp(leaf.id, root);
    }

    _propagateCollapseUp(nodeId, root) {
        const parent = this.findParent(nodeId, root);
        if (!parent) return;

        const allZero = parent.children.every(c => c.ratio === 0);
        if (allZero) {
            parent.savedRatio = parent.ratio;
            parent.ratio = 0;
            this._propagateCollapseUp(parent.id, root);
        }
    }

    _redistributeAfterCollapse(nodeId, root) {
        const parent = this.findParent(nodeId, root);
        if (!parent) return;

        const visible = parent.children.filter(c => c.ratio > 0);
        if (visible.length === 0) {
            // All siblings are zero — parent handled by propagate
            this._redistributeAfterCollapse(parent.id, root);
            return;
        }

        // Redistribute total ratio of parent proportionally among visible children
        const totalVisible = visible.reduce((sum, c) => sum + c.ratio, 0);
        const targetTotal = parent.ratio > 0 ? 1 : 0;
        if (totalVisible > 0) {
            visible.forEach(c => c.ratio = (c.ratio / totalVisible) * targetTotal);
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

        this._restoreAncestors(leaf.id, root);

        const parent = this.findParent(leaf.id, root) ?? root;

        console.log(`[Tiler] restoreNode: "${window.get_title()}" savedRatio=${leaf.savedRatio} snapshotLength=${leaf._siblingRatiosSnapshot?.length}`);
        console.log(`[Tiler] parent children before restore:`, JSON.stringify(parent.children.map(c => ({ id: c.id, ratio: c.ratio, savedRatio: c.savedRatio }))));

        if (leaf._siblingRatiosSnapshot) {
            leaf._siblingRatiosSnapshot.forEach(saved => {
                const sibling = parent.children.find(c => c.id === saved.id);
                if (!sibling) return;
                if (sibling !== leaf && sibling.savedRatio !== null) return;
                sibling.ratio = saved.ratio;
            });
            leaf._siblingRatiosSnapshot = null;
            leaf.savedRatio = null; // ← clear this too
        } else if (leaf.savedRatio !== null) {
            leaf.ratio = leaf.savedRatio;
            leaf.savedRatio = null; // ← already here but make sure it's present
        }

        const visibleSiblings = parent.children.filter(c => c.ratio > 0);
        if (visibleSiblings.length === 0) {
            leaf.ratio = 1;
            return;
        }

        if (visibleSiblings.length === 1 && visibleSiblings[0] === leaf) {
            leaf.ratio = 1;
            return;
        }

        this._renormalizeContainer(parent);
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
}