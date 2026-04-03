// resizeManager.js
import St from 'gi://St';
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';

export class ResizeManager {
    constructor(tracker, settings) {
        this._tracker = tracker;
        this._resizeMode = false;
        this._resizeWindow = null;
        this._indicator = null;
        this._settings = settings;
    }

    // No display/tracker signals needed — resizing is driven by keybindings
    // routed through the extension's key handler, not by GNOME grab events.
    enable() { }

    disable() {
        this._exitResizeMode();
    }

    // ─── Settings Accessors ──────────────────────────────────────────────────────

    get _stepH() {
        return this._settings.get_int('resize-step-h');
    }

    get _stepV() {
        return this._settings.get_int('resize-step-v');
    }

    get _gap() {
        return this._settings.get_int('gap-size');
    }

    get _borderRadius() {
        return this._settings.get_int('border-radius');
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    isInResizeMode() {
        return this._resizeMode;
    }

    toggleResizeMode(window) {
        if (this._resizeMode) {
            this._exitResizeMode();
        } else {
            this._enterResizeMode(window);
        }
    }

    // ─── Resize Mode Enter / Exit ────────────────────────────────────────────────

    _enterResizeMode(window) {
        if (!window) return;
        if (window.get_maximized() !== 0) return;

        this._resizeMode = true;
        this._resizeWindow = window;
        this._showIndicator(window);
        console.log(`[Tiler] resize mode: entered for "${window.get_title()}"`);
    }

    _exitResizeMode() {
        this._resizeMode = false;
        this._resizeWindow = null;
        this._hideIndicator();
        console.log(`[Tiler] resize mode: exited`);
    }

    // ─── Indicator ───────────────────────────────────────────────────────────────

    _showIndicator(window) {
        this._hideIndicator();

        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;

        this._indicator = new St.Widget({
            style: `border: 3px solid rgba(255, 100, 100, 0.9); border-radius: ${this._borderRadius}px; background-color: rgba(255, 100, 100, 0.08);`,
            reactive: false,
            x: frame.x - 3,
            y: frame.y - 3,
            width: frame.width + 6,
            height: frame.height + 6,
        });

        global.window_group.add_child(this._indicator);
        global.window_group.set_child_above_sibling(this._indicator, null);

        const actor = window.get_compositor_private();
        if (actor) {
            this._indicatorSignal = actor.connect('notify::position', () => {
                this._syncIndicator(window);
            });
            this._indicatorActor = actor;
        }
    }

    _syncIndicator(window) {
        if (!this._indicator) return;
        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;
        this._indicator.set_position(frame.x - 3, frame.y - 3);
        this._indicator.set_size(frame.width + 6, frame.height + 6);
    }

    _hideIndicator() {
        if (this._indicatorSignal && this._indicatorActor) {
            this._indicatorActor.disconnect(this._indicatorSignal);
            this._indicatorSignal = null;
            this._indicatorActor = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ─── Resize Logic ────────────────────────────────────────────────────────────

    resizeInDirection(direction, shrink = false) {
        if (!this._resizeMode || !this._resizeWindow) return;

        const window = this._resizeWindow;
        const wsIndex = window.get_workspace().index();

        if (this._tracker._floatingWindows.has(window)) {
            this._resizeFloating(window, direction, shrink);
            return;
        }

        const root = this._tracker.getRootForWorkspace(wsIndex);
        const innerRect = LayoutEngine.innerRect(wsIndex, this._gap);

        const isHorizontal = direction === 'left' || direction === 'right';
        const requiredDirection = isHorizontal ? 'horizontal' : 'vertical';

        const leaf = this._tracker._tree.findLeaf(window, root);
        if (!leaf) return;

        const resizeEdge = this._findResizeEdge(leaf, root, direction, requiredDirection);
        if (!resizeEdge) return;

        const { targetChild, neighbour, parent } = resizeEdge;

        const parentRect = LayoutEngine.getContainerRect(parent, root, innerRect, this._gap);
        if (!parentRect) return;

        const visibleSiblings = parent.children.filter(c => c.ratio > 0);
        const totalGaps = this._gap * (visibleSiblings.length - 1);
        const availableSize = isHorizontal
            ? parentRect.width - totalGaps
            : parentRect.height - totalGaps;

        const stepPixels = isHorizontal ? this._stepH : this._stepV;
        const stepRatio = stepPixels / availableSize;
        const minRatio = 0.1;

        if (shrink) {
            if (targetChild.ratio - stepRatio < minRatio) return;
            if (neighbour.ratio + stepRatio > 0.9) return;
            targetChild.ratio -= stepRatio;
            neighbour.ratio += stepRatio;
        } else {
            if (neighbour.ratio - stepRatio < minRatio) return;
            if (targetChild.ratio + stepRatio > 0.9) return;
            targetChild.ratio += stepRatio;
            neighbour.ratio -= stepRatio;
        }

        const layout = LayoutEngine.calculate(root, innerRect, this._gap);
        layout.forEach(({ window: w, x, y, width, height }) => {
            w.move_resize_frame(false, x, y, width, height);
        });

        this._syncIndicator(window);
    }

    _findResizeEdge(leaf, root, direction, requiredDirection) {
        let currentNode = leaf;

        while (currentNode) {
            const parent = this._tracker._tree.findParent(currentNode.id, root);
            if (!parent) {
                console.log(`[Tiler] findResizeEdge: no parent found for direction=${direction}`);
                return null;
            }

            if (parent.direction === requiredDirection) {
                const visibleChildren = parent.children.filter(c => c.ratio > 0);

                let nodeInParent = visibleChildren.find(c => c === currentNode);
                if (!nodeInParent) {
                    nodeInParent = visibleChildren.find(c =>
                        c.type === 'container' &&
                        this._tracker._tree.findNodeById(currentNode.id, c)
                    );
                }

                if (!nodeInParent) {
                    console.log(`[Tiler] findResizeEdge: nodeInParent not found, going up`);
                    currentNode = parent;
                    continue;
                }

                const idx = visibleChildren.indexOf(nodeInParent);
                const neighbourIdx = (direction === 'right' || direction === 'down')
                    ? idx + 1 : idx - 1;

                console.log(`[Tiler] findResizeEdge: direction=${direction} idx=${idx} neighbourIdx=${neighbourIdx} visibleCount=${visibleChildren.length}`);

                if (neighbourIdx >= 0 && neighbourIdx < visibleChildren.length) {
                    console.log(`[Tiler] findResizeEdge: found neighbour targetRatio=${nodeInParent.ratio} neighbourRatio=${visibleChildren[neighbourIdx].ratio}`);
                    return {
                        targetChild: nodeInParent,
                        neighbour: visibleChildren[neighbourIdx],
                        parent,
                    };
                }
            }

            currentNode = parent;
        }

        console.log(`[Tiler] findResizeEdge: exhausted tree for direction=${direction}`);
        return null;
    }

    _resizeFloating(window, direction, shrink = false) {
        const frame = window.get_frame_rect();
        let { x, y, width, height } = frame;
        const sign = shrink ? -1 : 1;

        const stepH = this._stepH;
        const stepV = this._stepV;

        switch (direction) {
            case 'right':
                width += sign * stepH;
                break;
            case 'left':
                width += sign * stepH;
                x -= sign * stepH;
                break;
            case 'down':
                height += sign * stepV;
                break;
            case 'up':
                height += sign * stepV;
                y -= sign * stepV;
                break;
        }

        width = Math.max(200, width);
        height = Math.max(150, height);
        window.move_resize_frame(false, x, y, width, height);
        this._syncIndicator(window);
    }
}