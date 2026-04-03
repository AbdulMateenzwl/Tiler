// layoutEngine.js

export class LayoutEngine {
    /**
     * Recursively calculate positions for all leaf nodes in the tree.
     * @param {object} node - root container or leaf node
     * @param {{x, y, width, height}} rect - available rectangle for this node
     * @param {number} gap - gap between windows
     * @returns {{window, x, y, width, height}[]} flat list of window positions
     */
    static calculate(node, rect, gap = 8) {
        if (node.type === 'leaf') {
            if (node.ratio === 0) return [];
            return [{
                window: node.window,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            }];
        }

        // Only process visible children
        const children = node.children.filter(c => c.ratio > 0);
        if (children.length === 0) return [];

        const totalRatio = children.reduce((sum, c) => sum + c.ratio, 0);
        const isHorizontal = node.direction === 'horizontal';
        const results = [];

        const totalGaps = gap * (children.length - 1);
        const availableSpace = isHorizontal
            ? rect.width - totalGaps
            : rect.height - totalGaps;

        let currentPos = isHorizontal ? rect.x : rect.y;

        for (const child of children) {
            const normalizedRatio = child.ratio / totalRatio;
            const childSize = Math.floor(availableSpace * normalizedRatio);

            const childRect = isHorizontal
                ? { x: Math.floor(currentPos), y: rect.y, width: childSize, height: rect.height }
                : { x: rect.x, y: Math.floor(currentPos), width: rect.width, height: childSize };

            results.push(...LayoutEngine.calculate(child, childRect, gap));
            currentPos += childSize + gap;
        }

        return results;
    }

    /**
     * Get the work area for a given workspace index.
     */
    static getWorkArea(wsIndex) {
        const workspace = global.workspace_manager.get_workspace_by_index(wsIndex);
        const monitor = global.display.get_primary_monitor();
        return workspace.get_work_area_for_monitor(monitor);
    }

    static innerRect(wsIndex, gap) {
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        return {
            x: workArea.x + gap,
            y: workArea.y + gap,
            width: workArea.width - gap * 2,
            height: workArea.height - gap * 2,
        };
    }

    static findParentWithDirection(node, root, direction, tree) {
        const parent = tree.findParent(node.id, root);
        if (!parent) return null;
        if (parent.direction === direction) return parent;
        return LayoutEngine.findParentWithDirection(parent, root, direction, tree);
    }

    static findDirectChildContaining(parent, leaf, tree) {
        for (const child of parent.children) {
            if (child === leaf) return child;
            if (child.type === 'container') {
                if (tree.findNodeById(leaf.id, child)) return child;
            }
        }
        return null;
    }

    static getContainerRect(container, root, innerRect, gap) {
        const layout = LayoutEngine.calculate(root, innerRect, gap);
        const children = [];
        LayoutEngine._collectLayoutForContainer(container, layout, children);
        if (children.length === 0) return null;

        const minX = Math.min(...children.map(l => l.x));
        const maxX = Math.max(...children.map(l => l.x + l.width));
        const minY = Math.min(...children.map(l => l.y));
        const maxY = Math.max(...children.map(l => l.y + l.height));

        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    static _collectLayoutForContainer(container, layout, results) {
        if (container.type === 'leaf') {
            const found = layout.find(l => l.window === container.window);
            if (found) results.push(found);
            return;
        }
        for (const child of container.children) {
            LayoutEngine._collectLayoutForContainer(child, layout, results);
        }
    }

}