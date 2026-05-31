// tileManager.js
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Named sets for GNOME grab-op numeric codes.
// These are undocumented internal values from Meta — grouping them here
// keeps the classification methods readable and avoids magic numbers scattered
// throughout the file.
const GrabOps = {
    KEYBOARD_MOVING: 1025,

    // Edge resizes (mouse only)
    TOP: new Set([32769, 33793]),
    BOTTOM: new Set([16385, 17409]),
    LEFT: new Set([4097, 36865, 20481, 5121, 37889, 21505]),
    RIGHT: new Set([8193, 40961, 24577, 9217, 41985, 25601]),

    // Corner = LEFT ∪ RIGHT (all have both a horizontal and vertical component)
    CORNER_LEFT: new Set([36865, 20481, 37889, 21505]),
    CORNER_RIGHT: new Set([40961, 24577, 41985, 25601]),
    CORNER_TOP: new Set([36865, 40961, 37889, 41985]),
    CORNER_BOTTOM: new Set([20481, 24577, 21505, 25601]),
};

// Derived composite sets (computed once, not rebuilt on every call)
GrabOps.CORNER = new Set([...GrabOps.CORNER_LEFT, ...GrabOps.CORNER_RIGHT]);
GrabOps.RESIZE = new Set([
    ...GrabOps.TOP, ...GrabOps.BOTTOM,
    ...GrabOps.LEFT, ...GrabOps.RIGHT,
]);

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
                this._applyLayoutImmediate(wsIndex);
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

    // ─── Shared Helpers ──────────────────────────────────────────────────────────

    _gapSize() {
        return this._settings.get_int('gap-size');
    }

    /**
     * Build the inner work-area rect (inset by gap on all sides) for a workspace.
     */
    _innerRect(wsIndex) {
        return LayoutEngine.innerRect(wsIndex, this._gapSize());
    }

    /**
     * Calculate and return the full layout array for a workspace.
     */
    _calculateLayout(wsIndex) {
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const innerRect = this._innerRect(wsIndex);
        return LayoutEngine.calculate(root, innerRect, this._gapSize());
    }

    /**
     * Apply a fully-calculated layout array to all windows,
     * skipping the actively-grabbed focused window if a grab is in progress.
     */
    _applyLayoutArray(layout) {
        layout.forEach(({ window, x, y, width, height }) => {
            if (this._grabActive && window === global.display.focus_window) return;
            this._moveWindow(window, x, y, width, height);
        });
    }

    _applyLayoutWithSnap(layout, snapWindow) {
        layout.forEach(({ window: w, x, y, width, height }) => {
            // Animate all windows including the dragged one
            this._animateWindow(w, x, y, width, height);
        });
    }

    /**
     * Create and show a highlight widget over a rect on the window_group.
     * Destroys any existing highlight first.
     */
    _showHighlight(x, y, width, height, style) {
        this._removeHighlight();

        this._highlightWidget = new St.Widget({
            style,
            reactive: false,
            x, y, width, height,
        });

        global.window_group.add_child(this._highlightWidget);
        global.window_group.set_child_above_sibling(this._highlightWidget, null);
    }

    /**
     * Start a 50 ms polling loop that tracks the mouse over tiled windows
     * and calls `onHit(targetWindow, extra)` / `onMiss()` when hover state changes.
     *
     * @param {Meta.Window} dragWindow  – the window being dragged (excluded from hit-test)
     * @param {number}      wsIndex     – workspace to inspect
     * @param {Function}    hitFn       – (targetWindow, mouseX, mouseY) → any; return value stored as dragTarget
     * @param {Function}    changeFn    – (newTarget, extra) called when target/extra change
     */
    _startDragPoll(dragWindow, wsIndex, hitFn, changeFn) {
        this._dragTarget = null;

        this._dragPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._dragWindow) return GLib.SOURCE_REMOVE;

            const [mouseX, mouseY] = global.get_pointer();
            const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);

            let newTarget = null;
            let extra = null;

            for (const w of tiledWindows) {
                if (w === this._dragWindow) continue;
                const frame = w.get_frame_rect();
                if (mouseX >= frame.x && mouseX <= frame.x + frame.width &&
                    mouseY >= frame.y && mouseY <= frame.y + frame.height) {
                    newTarget = w;
                    extra = hitFn(w, mouseX, mouseY);
                    break;
                }
            }

            if (newTarget !== this._dragTarget || extra !== this._dragPosition) {
                this._dragTarget = newTarget;
                this._dragPosition = extra;
                changeFn(newTarget, extra);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    // Stop the drag-poll timer and clear all drag state.
    _stopDragPoll() {
        if (this._dragPollId) {
            GLib.source_remove(this._dragPollId);
            this._dragPollId = null;
        }
        this._removeHighlight();
        this._dragWindow = null;
        this._dragTarget = null;
        this._dragPosition = null;
    }

    // ─── Insert Drag ─────────────────────────────────────────────────────────────

    _startInsertDragTracking(window, wsIndex) {
        this._startDragPoll(
            window, wsIndex,
            (targetWindow, mouseX, mouseY) => this._getDropPosition(targetWindow, mouseX, mouseY),
            (newTarget, newPosition) => this._updateInsertHighlight(newTarget, newPosition)
        );
    }

    _stopInsertDragTracking() {
        this._stopDragPoll();
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

        if (relX < leftZone) return 'before';
        if (relX > rightZone) return 'after';
        if (relY < topZone) return 'above';
        if (relY > bottomZone) return 'below';

        // Middle 40% — reserved
        return null;
    }

    // ─── Swap Drag ───────────────────────────────────────────────────────────────

    _startSwapDragTracking(window, wsIndex) {
        this._startDragPoll(
            window, wsIndex,
            (_targetWindow, _mouseX, _mouseY) => null,   // no extra data needed for swap
            (newTarget, _extra) => this._updateSwapHighlight(newTarget)
        );
    }

    _stopSwapDragTracking() {
        this._stopDragPoll();
    }

    // ─── Highlight Rendering ─────────────────────────────────────────────────────

    _updateInsertHighlight(window, position) {
        if (!window || !position) {
            this._removeHighlight();
            return;
        }

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

        this._showHighlight(
            x, y, width, height,
            'background-color: rgba(100, 150, 255, 0.35); border: 2px solid rgba(100, 150, 255, 0.9); border-radius: 8px;'
        );
    }

    _updateSwapHighlight(window) {
        if (!window) {
            this._removeHighlight();
            return;
        }

        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;

        this._showHighlight(
            frame.x, frame.y, frame.width, frame.height,
            'background-color: rgba(100, 150, 255, 0.25); border: 2px solid rgba(100, 150, 255, 0.8); border-radius: 12px;'
        );
    }

    _removeHighlight() {
        if (this._highlightWidget) {
            this._highlightWidget.destroy();
            this._highlightWidget = null;
        }
    }

    // ─── Drag End Handlers ───────────────────────────────────────────────────────

    _onInsertDragEnd(window, dragWindow, dragTarget, dragPosition) {
        if (!dragTarget || !dragWindow || !dragPosition) {
            this._onGrabOpEnd(window, Meta.GrabOp.MOVING);
            return;
        }

        const wsIndex = window.get_workspace().index();
        this._tracker._tree.insertWindowRelativeTo(dragWindow, dragTarget, dragPosition, wsIndex);

        const layout = this._calculateLayout(wsIndex);
        this._applyLayoutWithSnap(layout, dragWindow);
    }

    _onSwapDragEnd(window, dragWindow, dragTarget) {
        if (!dragTarget || !dragWindow) {
            this._onGrabOpEnd(window, Meta.GrabOp.MOVING);
            return;
        }

        const wsIndex = window.get_workspace().index();
        this._tracker._tree.swapWindows(dragWindow, dragTarget, wsIndex);

        const layout = this._calculateLayout(wsIndex);
        this._applyLayoutWithSnap(layout, dragWindow);
    }

    setDragMode(mode) {
        this._dragMode = mode;
    }

    // ─── Live Resize ─────────────────────────────────────────────────────────────

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

                if (hSnapshot && hAvailable > 0) {
                    const newHRatio = frame.width / hAvailable;
                    this._applySnapshotResize(hSnapshot, newHRatio, hSide);
                }

                if (vSnapshot && vAvailable > 0) {
                    const newVRatio = frame.height / vAvailable;
                    this._applySnapshotResize(vSnapshot, newVRatio, vSide);
                }

                this._lastTempRatios = [
                    ...(hSnapshot?.map(e => ({ nodeId: e.node.id, ratio: e.node.ratio })) ?? []),
                    ...(vSnapshot?.map(e => ({ nodeId: e.node.id, ratio: e.node.ratio })) ?? []),
                ];

                const layout = LayoutEngine.calculate(root, innerRect, this._gapSize());

                layout.forEach(({ window: w, x, y, width, height }) => {
                    if (w === window) return;
                    this._moveWindow(w, x, y, width, height);
                });

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
        return LayoutEngine.findParentWithDirection(node, root, direction, this._tracker._tree);
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

        const innerRect = this._innerRect(wsIndex);
        const root = this._tracker.getRootForWorkspace(wsIndex);

        if (this._isCornerResize(grabOp)) {
            this._startCornerResize(window, grabOp, root, innerRect, wsIndex);
            return;
        }

        const leaf = this._tracker._tree.findLeaf(window, root);

        const expectedDirection = isVertical ? 'vertical' : 'horizontal';
        const parent = this._findParentWithDirection(leaf, root, expectedDirection);

        const targetChild = parent ? this._findDirectChildContaining(parent, leaf) : null;

        const siblingsSnapshot = parent?.children
            .filter(c => c.ratio > 0)
            .map(c => ({ node: c, ratio: c.ratio, isTarget: c === targetChild }));

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
        return LayoutEngine.findDirectChildContaining(parent, leaf, this._tracker._tree);
    }

    _getContainerRect(container, root, innerRect) {
        return LayoutEngine.getContainerRect(container, root, innerRect, this._gapSize());
    }

    _stopLiveResize() {
        this._isResizing = false;
        if (this._liveResizeSignal) {
            this._liveResizeSignal.window.disconnect(this._liveResizeSignal.id);
            this._liveResizeSignal = null;
        }
    }

    // ─── Layout Scheduling ───────────────────────────────────────────────────────

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

    // ─── Focus Handling ──────────────────────────────────────────────────────────

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

                const layout = this._calculateLayout(wsIndex);
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

    // ─── Layout Application ──────────────────────────────────────────────────────

    _applyLayout(wsIndex) {
        this._applyingLayout = true;

        if (this._applyingLayoutTimer) {
            GLib.source_remove(this._applyingLayoutTimer);
            this._applyingLayoutTimer = null;
        }

        const layout = this._calculateLayout(wsIndex);

        layout.forEach(({ window, x, y, width, height }, index) => {
            if (this._grabActive && window === global.display.focus_window) return;
            if (this._isResizing) {
                this._moveWindow(window, x, y, width, height);
            } else {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, index * 20, () => {
                    this._animateWindow(window, x, y, width, height);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._applyingLayoutTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._applyingLayout = false;
            this._applyingLayoutTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyLayoutImmediate(wsIndex) {
        const layout = this._calculateLayout(wsIndex);
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

    // ─── Window Movement ─────────────────────────────────────────────────────────

    _moveWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) {
            return;
        }
        if (this._grabActive && window === global.display.focus_window) {
            return;
        }
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

        window.move_resize_frame(false, x, y, width, height);

        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;

        const targetActorX = x - offsetX;
        const targetActorY = y - offsetY;

        const currentX = actor.x;
        const currentY = actor.y;

        // Cancel any ongoing animation before starting new one
        actor.remove_all_transitions();

        actor.set_position(currentX, currentY);

        actor.ease({
            x: targetActorX,
            y: targetActorY,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
    }

    _onGrabOpEnd(window, grabOp) {
        if (!this._isMovingGrab(grabOp)) return;

        const wsIndex = window.get_workspace().index();
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (!windows.some(w => w === window)) return;

        const layout = this._calculateLayout(wsIndex);
        const target = layout.find(l => l.window === window);
        if (!target) return;

        this._animateWindow(window, target.x, target.y, target.width, target.height);
    }

    animateWindowToFloat(window, x, y, width, height) {
        // First set actual geometry so Mutter knows the final size
        window.move_resize_frame(false, x, y, width, height);

        // Then animate the actor from current position to float position
        const actor = window.get_compositor_private();
        if (!actor) return;

        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;

        const currentX = actor.x;
        const currentY = actor.y;
        const targetActorX = x - offsetX;
        const targetActorY = y - offsetY;

        actor.set_position(currentX, currentY);
        actor.ease({
            x: targetActorX,
            y: targetActorY,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ─── Grab Op Classification ──────────────────────────────────────────────────

    _isMovingGrab(grabOp) {
        return grabOp === Meta.GrabOp.MOVING ||
            grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
            grabOp === GrabOps.KEYBOARD_MOVING;
    }

    _isResizingGrab(grabOp) {
        return GrabOps.RESIZE.has(grabOp);
    }

    _isTopResize(grabOp) {
        return GrabOps.TOP.has(grabOp);
    }

    _isBottomResize(grabOp) {
        return GrabOps.BOTTOM.has(grabOp);
    }

    _isLeftResize(grabOp) {
        return GrabOps.LEFT.has(grabOp);
    }

    _isRightResize(grabOp) {
        return GrabOps.RIGHT.has(grabOp);
    }

    _isCornerResize(grabOp) {
        return GrabOps.CORNER.has(grabOp);
    }

    _cornerHorizontalSide(grabOp) {
        return GrabOps.CORNER_LEFT.has(grabOp) ? 'left' : 'right';
    }

    _cornerVerticalSide(grabOp) {
        return GrabOps.CORNER_TOP.has(grabOp) ? 'top' : 'bottom';
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

        const layout = this._calculateLayout(wsIndex);
        layout.forEach(({ window: w, x, y, width, height }) => {
            this._animateWindow(w, x, y, width, height);
        });
    }

}