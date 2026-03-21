// tileManager.js
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';

export class TileManager {
    constructor(tracker) {
        this._tracker = tracker;
        this._signals = [];
        this._displaySignals = [];
        this._layoutTimers = new Map();
    }

    enable() {
        this._grabActive = false;

        this._liveResizeSignal = null;

        this._isResizing = false;
        this._lastTempRatios = null;

        this._tracker.connect('window-added', (_, window, wsIndex) => {
            this._scheduleLayout(wsIndex);
        });

        this._tracker.connect('window-removed', (_, window, wsIndex) => {
            console.log(`[Tiler] window-removed wsIndex=${wsIndex}`);
            this._scheduleLayout(wsIndex);
        });

        this._tracker.connect('window-workspace-changed', (_, window, newWsIndex) => {
            const wsCount = global.workspace_manager.get_n_workspaces();
            for (let i = 0; i < wsCount; i++) {
                this._scheduleLayout(i);
            }
        });

        this._tracker.connect('window-unmaximized', (_, window, wsIndex) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._raiseTiledWindows(wsIndex);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._tracker.connect('window-maximized', (_, window, wsIndex) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._lowerTiledWindows(wsIndex);
                window.raise();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._displaySignals.push(
            global.display.connect('notify::focus-window', () => {
                this._onFocusChanged();
            })
        );

        this._displaySignals.push(
            global.display.connect('grab-op-begin', (display, window, grabOp) => {
                if (this._isMovingGrab(grabOp))
                    this._grabActive = true;
                if (this._isResizingGrab(grabOp)) {
                    this._resizeGrabOp = grabOp;
                    this._startLiveResize(window, grabOp);
                }
            })
        );

        this._displaySignals.push(
            global.display.connect('grab-op-end', (display, window, grabOp) => {
                this._grabActive = false;
                if (this._isResizingGrab(grabOp)) {
                    this._stopLiveResize();
                    this._onResizeEnd(window, grabOp);
                    this._resizeGrabOp = null;
                } else {
                    this._onGrabOpEnd(window, grabOp);
                }
            })
        );

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            const wsCount = global.workspace_manager.get_n_workspaces();
            for (let i = 0; i < wsCount; i++) {
                this._applyLayout(i);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._signals.forEach(id => this._tracker.disconnect(id));
        this._signals = [];

        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];

        for (const id of this._layoutTimers.values()) {
            GLib.source_remove(id);
        }
        this._layoutTimers.clear();

        this._stopLiveResize();
    }

    _startCornerResize(window, grabOp, root, innerRect, wsIndex) {
        const hSide = this._cornerHorizontalSide(grabOp);
        const vSide = this._cornerVerticalSide(grabOp);

        const leaf = this._tracker._tree.findLeaf(window, root);
        if (!leaf) return;

        const hParent = this._findParentWithDirection(leaf, root, 'horizontal');
        const vParent = this._findParentWithDirection(leaf, root, 'vertical');

        const hTargetChild = hParent ? this._findDirectChildContaining(hParent, leaf) : null;
        const vTargetChild = vParent ? this._findDirectChildContaining(vParent, leaf) : null;

        const hSnapshot = hParent ? hParent.children
            .filter(c => c.ratio > 0)
            .map(c => ({ node: c, ratio: c.ratio, isTarget: c === hTargetChild }))
            : null;

        const vSnapshot = vParent ? vParent.children
            .filter(c => c.ratio > 0)
            .map(c => ({ node: c, ratio: c.ratio, isTarget: c === vTargetChild }))
            : null;

        const hParentLayout = hParent ? this._getContainerRect(hParent, root, innerRect) : null;
        const vParentLayout = vParent ? this._getContainerRect(vParent, root, innerRect) : null;

        const hAvailable = hParentLayout ? hParentLayout.width - 8 * ((hSnapshot?.length ?? 1) - 1) : 0;
        const vAvailable = vParentLayout ? vParentLayout.height - 8 * ((vSnapshot?.length ?? 1) - 1) : 0;

        this._liveResizeSignal = {
            window,
            id: window.connect('size-changed', () => {
                const frame = window.get_frame_rect();

                // Apply both horizontal and vertical temp ratios simultaneously
                if (hSnapshot && hAvailable > 0) {
                    const newHRatio = frame.width / hAvailable;
                    this._applySnapshotResize(hSnapshot, newHRatio, hSide);
                }

                if (vSnapshot && vAvailable > 0) {
                    const newVRatio = frame.height / vAvailable;
                    this._applySnapshotResize(vSnapshot, newVRatio, vSide);
                }

                // Save temp ratios for commit
                this._lastTempRatios = [
                    ...(hSnapshot?.map(e => ({ nodeId: e.node.id, ratio: e.node.ratio })) ?? []),
                    ...(vSnapshot?.map(e => ({ nodeId: e.node.id, ratio: e.node.ratio })) ?? []),
                ];

                // Single full layout recalculation with both axes applied
                const layout = LayoutEngine.calculate(root, innerRect, 8);

                // Move all windows except the dragged one
                layout.forEach(({ window: w, x, y, width, height }) => {
                    if (w === window) return;
                    this._moveWindow(w, x, y, width, height);
                });

                // Restore both snapshots
                hSnapshot?.forEach(e => e.node.ratio = e.ratio);
                vSnapshot?.forEach(e => e.node.ratio = e.ratio);
            })
        };
    }

    _applySnapshotResize(snapshot, newRatio, side) {
        const targetIdx = snapshot.findIndex(e => e.isTarget);
        if (targetIdx === -1) return;

        const oldRatio = snapshot[targetIdx].ratio;
        const delta = newRatio - oldRatio;

        const neighbours = (side === 'right' || side === 'bottom')
            ? snapshot.slice(targetIdx + 1)
            : snapshot.slice(0, targetIdx);

        if (neighbours.length === 0) return;

        const perNeighbour = delta / neighbours.length;
        snapshot[targetIdx].node.ratio = newRatio;
        neighbours.forEach(e => e.node.ratio = e.ratio - perNeighbour);
    }

    _findParentWithDirection(node, root, direction) {
        const parent = this._tracker._tree.findParent(node.id, root);
        if (!parent) return null;
        if (parent.direction === direction) return parent;
        return this._findParentWithDirection(parent, root, direction);
    }

    _isAncestorOf(node, leaf) {
        if (node.type === 'leaf') return false;
        for (const child of node.children) {
            if (child === leaf) return true;
            if (this._isAncestorOf(child, leaf)) return true;
        }
        return false;
    }

    _startLiveResize(window, grabOp) {
        this._stopLiveResize();
        this._isResizing = true;
        this._lastTempRatios = null;

        const wsIndex = window.get_workspace().index();
        const isVertical = this._isTopResize(grabOp) || this._isBottomResize(grabOp);
        const side = this._isRightResize(grabOp) ? 'right'
            : this._isLeftResize(grabOp) ? 'left'
                : this._isBottomResize(grabOp) ? 'bottom'
                    : 'top';

        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const innerRect = {
            x: workArea.x + 8, y: workArea.y + 8,
            width: workArea.width - 16, height: workArea.height - 16,
        };

        const root = this._tracker.getRootForWorkspace(wsIndex);

        if (this._isCornerResize(grabOp)) {
            this._startCornerResize(window, grabOp, root, innerRect, wsIndex);
            return;
        }

        const leaf = this._tracker._tree.findLeaf(window, root);
        console.log(`[Tiler] startLiveResize: "${window.get_title()}" grabOp=${grabOp} isVertical=${isVertical} side=${side}`);
        console.log(`[Tiler] leaf found=${!!leaf}`);

        const expectedDirection = isVertical ? 'vertical' : 'horizontal';
        const parent = this._findParentWithDirection(leaf, root, expectedDirection);
        console.log(`[Tiler] parent found=${!!parent} direction=${parent?.direction}`);

        const targetChild = parent ? this._findDirectChildContaining(parent, leaf) : null;
        console.log(`[Tiler] targetChild=${targetChild?.type} id=${targetChild?.id}`);

        console.log(`[Tiler] liveResize: "${window.get_title()}" side=${side} parent=${parent?.direction} targetChild=${targetChild?.type} siblings=${parent?.children.filter(c => c.ratio > 0).length}`);

        const siblingsSnapshot = parent?.children
            .filter(c => c.ratio > 0)
            .map(c => ({ node: c, ratio: c.ratio, isTarget: c === targetChild }));
        console.log(`[Tiler] siblings=${siblingsSnapshot?.length} target in siblings=${siblingsSnapshot?.some(s => s.isTarget)}`);

        const parentLayout = this._getContainerRect(parent, root, innerRect);
        if (!parentLayout) return;

        const totalGaps = 8 * (siblingsSnapshot.length - 1);
        const availableSize = isVertical
            ? parentLayout.height - totalGaps
            : parentLayout.width - totalGaps;

        this._liveResizeSignal = {
            window,
            id: window.connect('size-changed', () => {
                const frame = window.get_frame_rect();
                const newRatio = (isVertical ? frame.height : frame.width) / availableSize;

                const targetIdx = siblingsSnapshot.findIndex(e => e.isTarget);
                if (targetIdx === -1) return;

                const oldRatio = siblingsSnapshot[targetIdx].ratio;
                const delta = newRatio - oldRatio;

                const neighbours = (side === 'right' || side === 'bottom')
                    ? siblingsSnapshot.slice(targetIdx + 1)
                    : siblingsSnapshot.slice(0, targetIdx);

                if (neighbours.length === 0) return;

                const perNeighbour = delta / neighbours.length;

                siblingsSnapshot.forEach(e => {
                    if (e.isTarget) {
                        e.node.ratio = newRatio;
                    } else if (neighbours.some(n => n === e)) {
                        e.node.ratio = e.ratio - perNeighbour;
                    }
                });

                this._lastTempRatios = siblingsSnapshot.map(e => ({
                    nodeId: e.node.id,
                    ratio: e.node.ratio,
                }));

                // Only recalculate and move windows inside the resizing container
                const containerLayout = LayoutEngine.calculate(parent,
                    this._getContainerRect(parent, root, innerRect), 8);

                containerLayout.forEach(({ window: w, x, y, width, height }) => {
                    if (w === window) return;
                    this._moveWindow(w, x, y, width, height);
                });

                siblingsSnapshot.forEach(e => e.node.ratio = e.ratio);
            })
        };
    }

    _findDirectChildContaining(parent, leaf) {
        for (const child of parent.children) {
            if (child === leaf) return child;
            if (child.type === 'container') {
                // Check if leaf is inside this container
                if (this._tracker._tree.findNodeById(leaf.id, child)) return child;
            }
        }
        return null;
    }

    _getContainerRect(container, root, innerRect) {
        // Calculate layout and find bounds of this container's children
        const layout = LayoutEngine.calculate(root, innerRect, 8);
        const children = [];
        this._collectLayoutForContainer(container, layout, children);
        if (children.length === 0) return null;

        const minX = Math.min(...children.map(l => l.x));
        const maxX = Math.max(...children.map(l => l.x + l.width));
        const minY = Math.min(...children.map(l => l.y));
        const maxY = Math.max(...children.map(l => l.y + l.height));

        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    _collectLayoutForContainer(container, layout, results) {
        if (container.type === 'leaf') {
            const found = layout.find(l => l.window === container.window);
            if (found) results.push(found);
            return;
        }
        for (const child of container.children) {
            this._collectLayoutForContainer(child, layout, results);
        }
    }

    _stopLiveResize() {
        this._isResizing = false;
        if (this._liveResizeSignal) {
            this._liveResizeSignal.window.disconnect(this._liveResizeSignal.id);
            this._liveResizeSignal = null;
        }
    }

    _scheduleLayout(wsIndex) {
        if (this._isResizing) return;
        if (this._layoutTimers.has(wsIndex)) {
            GLib.source_remove(this._layoutTimers.get(wsIndex));
            this._layoutTimers.delete(wsIndex);
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._layoutTimers.delete(wsIndex);
            this._applyLayout(wsIndex);
            return GLib.SOURCE_REMOVE;
        });

        this._layoutTimers.set(wsIndex, id);
    }

    _onFocusChanged() {
        const focused = global.display.focus_window;
        if (!focused) return;

        const wsIndex = focused.get_workspace().index();
        const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (!tiledWindows.some(w => w === focused)) return;

        this._raiseTiledWindows(wsIndex);

        // Snap focused window back to its tiled position after any self-resize
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const innerRect = {
            x: workArea.x + 8, y: workArea.y + 8,
            width: workArea.width - 16, height: workArea.height - 16,
        };
        const layout = LayoutEngine.calculate(root, innerRect, 8);
        const target = layout.find(l => l.window === focused);
        if (!target) return;

        // Watch for self-resize after focus, snap back once
        const id = focused.connect('size-changed', () => {
            focused.disconnect(id);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const frame = focused.get_frame_rect();
                if (frame.width !== target.width || frame.height !== target.height) {
                    focused.move_resize_frame(false, target.x, target.y, target.width, target.height);
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        // Disconnect after 500ms if no resize happened
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            try { focused.disconnect(id); } catch { }
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyLayout(wsIndex) {
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);

        // Add outer gap
        const innerRect = {
            x: workArea.x + 8,
            y: workArea.y + 8,
            width: workArea.width - 16,
            height: workArea.height - 16,
        };

        const layout = LayoutEngine.calculate(root, innerRect, 8);

        layout.forEach(({ window, x, y, width, height }) => {
            if (this._grabActive && window === global.display.focus_window) return;
            this._moveWindow(window, x, y, width, height);
        });
    }

    _raiseTiledWindows(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (windows.length === 0) return;
        windows.forEach(w => w.raise());
    }

    _lowerTiledWindows(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (windows.length === 0) return;
        windows.forEach(w => w.lower());
    }

    _moveWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        const frame = window.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                window.move_resize_frame(false, x, y, width, height);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        window.move_resize_frame(false, x, y, width, height);
    }

    _animateWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        const currentX = actor.x;
        const currentY = actor.y;

        window.move_resize_frame(false, x, y, width, height);

        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;
        const targetActorX = x - offsetX;
        const targetActorY = y - offsetY;

        actor.set_position(currentX, currentY);
        actor.ease({
            x: targetActorX,
            y: targetActorY,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onGrabOpEnd(window, grabOp) {
        if (!this._isMovingGrab(grabOp)) return;

        const wsIndex = window.get_workspace().index();
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (!windows.some(w => w === window)) return;

        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const innerRect = {
            x: workArea.x + 8, y: workArea.y + 8,
            width: workArea.width - 16, height: workArea.height - 16,
        };

        const layout = LayoutEngine.calculate(root, innerRect, 8);
        const target = layout.find(l => l.window === window);
        if (!target) return;

        this._animateWindow(window, target.x, target.y, target.width, target.height);
    }

    _isMovingGrab(grabOp) {
        return grabOp === Meta.GrabOp.MOVING ||
            grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
            grabOp === 1025;
    }

    _isResizingGrab(grabOp) {
        return [
            4097, 8193, 36865, 20481, 40961, 24577,  // mouse horizontal resize
            5121, 9217, 37889, 21505, 41985, 25601,  // Super+mouse horizontal resize
            32769, 16385,                              // mouse vertical resize (top, bottom)
            33793, 17409                               // Super+mouse vertical resize (top, bottom)
        ].includes(grabOp);
    }

    _isTopResize(grabOp) {
        return [32769, 33793].includes(grabOp);
    }

    _isBottomResize(grabOp) {
        return [16385, 17409].includes(grabOp);
    }

    _isLeftResize(grabOp) {
        return [4097, 36865, 20481, 5121, 37889, 21505].includes(grabOp);
    }

    _isRightResize(grabOp) {
        return [8193, 40961, 24577, 9217, 41985, 25601].includes(grabOp);
    }

    _isCornerResize(grabOp) {
        return [36865, 20481, 40961, 24577, 37889, 21505, 41985, 25601].includes(grabOp);
    }

    _cornerHorizontalSide(grabOp) {
        // left corners
        if ([36865, 20481, 37889, 21505].includes(grabOp)) return 'left';
        // right corners
        return 'right';
    }

    _cornerVerticalSide(grabOp) {
        // top corners
        if ([36865, 40961, 37889, 41985].includes(grabOp)) return 'top';
        // bottom corners
        return 'bottom';
    }

    _onResizeEnd(window, grabOp) {
        const wsIndex = window.get_workspace().index();

        if (this._lastTempRatios) {
            const root = this._tracker.getRootForWorkspace(wsIndex);
            this._lastTempRatios.forEach(({ nodeId, ratio }) => {
                const node = this._tracker._tree.findNodeById(nodeId, root);
                if (node && node.ratio > 0) node.ratio = ratio;
            });
            this._lastTempRatios = null;
        }

        this._applyLayout(wsIndex);
    }

}