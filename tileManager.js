// tileManager.js
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class TileManager {
    constructor(tracker, settings) {
        this._tracker = tracker;
        this._settings = settings;
        this._signals = [];
        this._displaySignals = [];
        this._layoutTimers = new Map();
    }

    enable() {
        this._grabActive = false;

        this._liveResizeSignal = null;

        this._isResizing = false;
        this._lastTempRatios = null;

        this._applyingLayout = false;

        this._dragWindow = null;
        this._dragTarget = null;
        this._highlightWidget = null;

        this._dragPosition = null;

        this._dragMode = 'insert';
        this._dragPollId = null;

        this._applyingLayoutTimer = null;

        this._focusSizeSignal = null;
        this._focusCleanupTimer = null;

        this._signals.push(
            this._tracker.connect('window-added', (_, window, wsIndex) => {
                this._scheduleLayout(wsIndex);
            })
        );

        this._signals.push(
            this._tracker.connect('window-removed', (_, window, wsIndex) => {
                this._scheduleLayout(wsIndex);
            })
        );

        this._signals.push(
            this._tracker.connect('window-workspace-changed', (_, window, newWsIndex) => {
                const wsCount = global.workspace_manager.get_n_workspaces();
                for (let i = 0; i < wsCount; i++) {
                    this._scheduleLayout(i);
                }
            })
        );

        this._signals.push(
            this._tracker.connect('window-unmaximized', (_, window, wsIndex) => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._raiseTiledWindows(wsIndex);
                    return GLib.SOURCE_REMOVE;
                });
            })
        );

        this._signals.push(
            this._tracker.connect('window-maximized', (_, window, wsIndex) => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._lowerTiledWindows(wsIndex);
                    window.raise();
                    return GLib.SOURCE_REMOVE;
                });
            })
        );

        this._displaySignals.push(
            global.display.connect('notify::focus-window', () => {
                this._onFocusChanged();
            })
        );

        this._displaySignals.push(
            global.display.connect('grab-op-begin', (display, window, grabOp) => {
                if (this._isMovingGrab(grabOp)) {
                    this._grabActive = true;
                    const wsIndex = window.get_workspace()?.index();
                    if (wsIndex !== undefined) {
                        const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);
                        if (tiledWindows.some(w => w === window) &&
                            !this._tracker._floatingWindows.has(window)) {
                            this._dragWindow = window;
                            if (this._dragMode === 'swap') {
                                this._startSwapDragTracking(window, wsIndex);
                            } else {
                                this._startInsertDragTracking(window, wsIndex);
                            }
                        }
                    }
                }
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
                } else if (this._isMovingGrab(grabOp)) {
                    const dragWindow = this._dragWindow;
                    const dragTarget = this._dragTarget;
                    const dragPosition = this._dragPosition;
                    if (this._dragMode === 'swap') {
                        this._stopSwapDragTracking();
                        this._onSwapDragEnd(window, dragWindow, dragTarget);
                    } else {
                        this._stopInsertDragTracking();
                        this._onInsertDragEnd(window, dragWindow, dragTarget, dragPosition);
                    }
                    this._dragMode = 'insert';
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

        this._stopInsertDragTracking();

        this._stopSwapDragTracking();

        if (this._applyingLayoutTimer) {
            GLib.source_remove(this._applyingLayoutTimer);
            this._applyingLayoutTimer = null;
        }

        if (this._focusSizeSignal) {
            try { this._focusSizeSignal.window.disconnect(this._focusSizeSignal.id); } catch { }
            this._focusSizeSignal = null;
        }
        if (this._focusCleanupTimer) {
            GLib.source_remove(this._focusCleanupTimer);
            this._focusCleanupTimer = null;
        }
    }

    _gapSize(){
        return this._settings.get_int('gap-size');
    }

    _startInsertDragTracking(window, wsIndex) {
        this._dragTarget = null;
        this._dragPosition = null;

        this._dragPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._dragWindow) return GLib.SOURCE_REMOVE;

            const [mouseX, mouseY] = global.get_pointer();
            const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);

            let newTarget = null;
            let newPosition = null;

            for (const w of tiledWindows) {
                if (w === this._dragWindow) continue;
                const frame = w.get_frame_rect();
                if (mouseX >= frame.x && mouseX <= frame.x + frame.width &&
                    mouseY >= frame.y && mouseY <= frame.y + frame.height) {
                    newTarget = w;
                    newPosition = this._getDropPosition(w, mouseX, mouseY);
                    break;
                }
            }

            if (newTarget !== this._dragTarget || newPosition !== this._dragPosition) {
                this._dragTarget = newTarget;
                this._dragPosition = newPosition;
                this._updateInsertHighlight(newTarget, newPosition);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopInsertDragTracking() {
        if (this._dragPollId) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
        }
        this._removeHighlight();
        this._dragWindow = null;
        this._dragTarget = null;
        this._dragPosition = null;
    }

    _getDropPosition(targetWindow, mouseX, mouseY) {
        const frame = targetWindow.get_frame_rect();
        const relX = mouseX - frame.x;
        const relY = mouseY - frame.y;
        const w = frame.width;
        const h = frame.height;

        const leftZone = w * 0.3;
        const rightZone = w * 0.7;
        const topZone = h * 0.3;
        const bottomZone = h * 0.7;

        // Check horizontal zones first
        if (relX < leftZone) return 'before';
        if (relX > rightZone) return 'after';

        // Then vertical zones
        if (relY < topZone) return 'above';
        if (relY > bottomZone) return 'below';

        // Middle 40% — reserved
        return null;
    }

    _startSwapDragTracking(window, wsIndex) {
        this._dragTarget = null;

        // Poll mouse position every 50ms during drag
        this._dragPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._dragWindow) return GLib.SOURCE_REMOVE;

            const [mouseX, mouseY] = global.get_pointer();
            const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);

            let newTarget = null;
            for (const w of tiledWindows) {
                if (w === this._dragWindow) continue;
                const frame = w.get_frame_rect();
                if (mouseX >= frame.x && mouseX <= frame.x + frame.width &&
                    mouseY >= frame.y && mouseY <= frame.y + frame.height) {
                    newTarget = w;
                    break;
                }
            }

            if (newTarget !== this._dragTarget) {
                this._dragTarget = newTarget;
                this._updateSwapHighlight(newTarget);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSwapDragTracking() {
        if (this._dragPollId) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
        }
        this._removeHighlight();
        this._dragWindow = null;
        this._dragTarget = null;
    }

    _updateInsertHighlight(window, position) {
        this._removeHighlight();
        if (!window || !position) return;

        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;

        let x, y, width, height;

        switch (position) {
            case 'before':
                x = frame.x;
                y = frame.y;
                width = Math.floor(frame.width / 2);
                height = frame.height;
                break;
            case 'after':
                x = frame.x + Math.floor(frame.width / 2);
                y = frame.y;
                width = Math.floor(frame.width / 2);
                height = frame.height;
                break;
            case 'above':
                x = frame.x;
                y = frame.y;
                width = frame.width;
                height = Math.floor(frame.height / 2);
                break;
            case 'below':
                x = frame.x;
                y = frame.y + Math.floor(frame.height / 2);
                width = frame.width;
                height = Math.floor(frame.height / 2);
                break;
        }

        this._highlightWidget = new St.Widget({
            style: 'background-color: rgba(100, 150, 255, 0.35); border: 2px solid rgba(100, 150, 255, 0.9); border-radius: 8px;',
            reactive: false,
            x, y, width, height,
        });

        global.window_group.add_child(this._highlightWidget);
        global.window_group.set_child_above_sibling(this._highlightWidget, null);
    }

    _updateSwapHighlight(window) {
        this._removeHighlight();
        if (!window) return;

        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;

        this._highlightWidget = new St.Widget({
            style: 'background-color: rgba(100, 150, 255, 0.25); border: 2px solid rgba(100, 150, 255, 0.8); border-radius: 12px;',
            reactive: false,
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        });

        global.window_group.add_child(this._highlightWidget);
        global.window_group.set_child_above_sibling(this._highlightWidget, null);
    }

    _removeHighlight() {
        if (this._highlightWidget) {
            this._highlightWidget.destroy();
            this._highlightWidget = null;
        }
    }

    _onInsertDragEnd(window, dragWindow, dragTarget, dragPosition) {
        if (!dragTarget || !dragWindow || !dragPosition) {
            this._onGrabOpEnd(window, Meta.GrabOp.MOVING);
            return;
        }

        const wsIndex = window.get_workspace().index();
        this._tracker._tree.insertWindowRelativeTo(dragWindow, dragTarget, dragPosition, wsIndex);

        const root = this._tracker.getRootForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const innerRect = {
            x: workArea.x + this._gapSize(), y: workArea.y + this._gapSize(),
            width: workArea.width - this._gapSize() * 2, height: workArea.height - this._gapSize() * 2,
        };
        const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());
        layout.forEach(({ window: w, x, y, width, height }) => {
            if (w === dragWindow) return;
            this._animateWindow(w, x, y, width, height);
        });

        const dragTarget2 = layout.find(l => l.window === dragWindow);
        if (dragTarget2) {
            this._moveWindow(dragWindow, dragTarget2.x, dragTarget2.y, dragTarget2.width, dragTarget2.height);
        }
    }

    _onSwapDragEnd(window, dragWindow, dragTarget) {
        if (!dragTarget || !dragWindow) {
            this._onGrabOpEnd(window, Meta.GrabOp.MOVING);
            return;
        }

        const wsIndex = window.get_workspace().index();
        this._tracker._tree.swapWindows(dragWindow, dragTarget, wsIndex);

        // Animate both windows to their new positions
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const innerRect = {
            x: workArea.x + this._gapSize(), y: workArea.y + this._gapSize(),
            width: workArea.width - this._gapSize() * 2, height: workArea.height - this._gapSize() * 2,
        };
        const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());
        layout.forEach(({ window: w, x, y, width, height }) => {
            if (w === dragWindow) return; // dragged window already at drop position
            this._animateWindow(w, x, y, width, height);
        });

        // Move dragged window directly without animation
        const dragTarget2 = layout.find(l => l.window === dragWindow);
        if (dragTarget2) {
            this._moveWindow(dragWindow, dragTarget2.x, dragTarget2.y, dragTarget2.width, dragTarget2.height);
        }
    }

    setDragMode(mode) {
        this._dragMode = mode;
        console.log(`[Tiler] drag mode: ${mode}`);
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

        const hAvailable = hParentLayout ? hParentLayout.width - this._gapSize() * ((hSnapshot?.length ?? 1) - 1) : 0;
        const vAvailable = vParentLayout ? vParentLayout.height - this._gapSize() * ((vSnapshot?.length ?? 1) - 1) : 0;

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
                const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());

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
        if (this._tracker._floatingWindows.has(window)) return;
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
        const gap = this._gapSize();
        const innerRect = {
            x: workArea.x + gap, y: workArea.y + gap,
            width: workArea.width - gap * 2, height: workArea.height - gap * 2,
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

        const totalGaps = this._gapSize() * (siblingsSnapshot.length - 1);
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
                    this._getContainerRect(parent, root, innerRect), this._gapSize());

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
        const gap = this._gapSize();
        const layout = LayoutEngine.calculate(root, innerRect, gap);
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

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._layoutTimers.delete(wsIndex);
            this._applyLayout(wsIndex);
            return GLib.SOURCE_REMOVE;
        });

        this._layoutTimers.set(wsIndex, id);
    }

    _onFocusChanged() {
        if (this._focusSizeSignal) {
            try { this._focusSizeSignal.window.disconnect(this._focusSizeSignal.id); } catch { }
            this._focusSizeSignal = null;
        }
        if (this._focusCleanupTimer) {
            GLib.source_remove(this._focusCleanupTimer);
            this._focusCleanupTimer = null;
        }

        const focused = global.display.focus_window;
        if (!focused) return;

        const wsIndex = focused.get_workspace().index();
        const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (!tiledWindows.some(w => w === focused)) return;

        this._raiseTiledWindows(wsIndex);

        const id = focused.connect('size-changed', () => {
            focused.disconnect(id);
            this._focusSizeSignal = null;

            if (this._applyingLayout) return;

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (this._applyingLayout) return GLib.SOURCE_REMOVE;

                const root = this._tracker.getRootForWorkspace(wsIndex);
                const workArea = LayoutEngine.getWorkArea(wsIndex);
                const innerRect = {
                    x: workArea.x + this._gapSize(), y: workArea.y + this._gapSize(),
                    width: workArea.width - this._gapSize() * 2, height: workArea.height - this._gapSize() * 2,
                };
                const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());
                const target = layout.find(l => l.window === focused);
                if (!target) return GLib.SOURCE_REMOVE;

                const frame = focused.get_frame_rect();
                if (frame.width !== target.width || frame.height !== target.height) {
                    focused.move_resize_frame(false, target.x, target.y, target.width, target.height);
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        this._focusSizeSignal = { window: focused, id };

        this._focusCleanupTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._focusSizeSignal?.id === id) {
                try { focused.disconnect(id); } catch { }
                this._focusSizeSignal = null;
            }
            this._focusCleanupTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyLayout(wsIndex) {
        this._applyingLayout = true;

        if (this._applyingLayoutTimer) {
            GLib.source_remove(this._applyingLayoutTimer);
            this._applyingLayoutTimer = null;
        }

        const root = this._tracker.getRootForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const gap = this._gapSize();
        const innerRect = {
            x: workArea.x + gap,
            y: workArea.y + gap,
            width: workArea.width - gap * 2,
            height: workArea.height - gap * 2,
        };
        const layout = LayoutEngine.calculate(root, innerRect, gap);
        layout.forEach(({ window, x, y, width, height }) => {
            if (this._grabActive && window === global.display.focus_window) return;
            this._moveWindow(window, x, y, width, height);
        });

        this._applyingLayoutTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._applyingLayout = false;
            this._applyingLayoutTimer = null;
            return GLib.SOURCE_REMOVE;
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
        if (!actor) {
            console.log(`[Tiler] _moveWindow: no actor for "${window.get_title()}"`);
            return;
        }
        if (this._grabActive && window === global.display.focus_window) {
            console.log(`[Tiler] _moveWindow: skipping "${window.get_title()}" — grab active`);
            return;
        }
        const frame = window.get_frame_rect();
        console.log(`[Tiler] _moveWindow: "${window.get_title()}" to ${x},${y} ${width}x${height} frame=${frame.x},${frame.y} ${frame.width}x${frame.height}`);
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
            x: workArea.x + this._gapSize(), y: workArea.y + this._gapSize(),
            width: workArea.width - this._gapSize() * 2, height: workArea.height - this._gapSize() * 2,
        };

        const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());
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