
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { LayoutEngine } from './layoutEngine.js';

export class Keybindings {
    constructor(tileManager, tracker, settings, resizeManager) {
        this._tileManager = tileManager;
        this._tracker = tracker;
        this._settings = settings;
        this._resizeManager = resizeManager;
    }

    enable() {
        Main.wm.addKeybinding(
            'retile-windows',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._retileAll(wsIndex);
            }
        );

        Main.wm.addKeybinding(
            'split-horizontal',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._tracker.setPendingSplit(wsIndex, 'horizontal');
                console.log(`[Tiler] pending split: horizontal`);
            }
        );

        Main.wm.addKeybinding(
            'split-vertical',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._tracker.setPendingSplit(wsIndex, 'vertical');
                console.log(`[Tiler] pending split: vertical`);
            }
        );

        Main.wm.addKeybinding(
            'toggle-float',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const focused = global.display.focus_window;
                if (!focused) return;
                this._tracker.toggleFloat(focused);
            }
        );

        Main.wm.addKeybinding(
            'drag-mode-swap',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                this._tileManager.setDragMode('swap');
            }
        );

        Main.wm.addKeybinding(
            'drag-mode-insert',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                this._tileManager.setDragMode('insert');
            }
        );

        const directions = ['left', 'right', 'up', 'down'];
        const keys = ['focus-left', 'focus-right', 'focus-up', 'focus-down'];

        directions.forEach((direction, i) => {
            Main.wm.addKeybinding(
                keys[i],
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => {
                    const focused = global.display.focus_window;
                    if (!focused) return;

                    const wsIndex = global.workspace_manager.get_active_workspace_index();
                    const root = this._tracker.getRootForWorkspace(wsIndex);
                    const workArea = global.workspace_manager
                        .get_workspace_by_index(wsIndex)
                        .get_work_area_for_monitor(global.display.get_primary_monitor());

                    const innerRect = {
                        x: workArea.x + this._gap, y: workArea.y + this._gap,
                        width: workArea.width - this._gap * 2, height: workArea.height - this._gap * 2,
                    };

                    const layout = LayoutEngine.calculate(root, innerRect, this._gap);
                    const target = this._tracker._tree.findWindowInDirection(focused, direction, layout);
                    if (target) target.focus(global.get_current_time());
                }
            );
        });

        Main.wm.addKeybinding(
            'toggle-resize-mode',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                console.log(`[Tiler] toggle resize mode`);
                const focused = global.display.focus_window;
                this._resizeManager.toggleResizeMode(focused);
            }
        );

        // Resize direction bindings — only active when in resize mode
        const resizeKeys = ['resize-left', 'resize-right', 'resize-up', 'resize-down'];
        const resizeDirs = ['left', 'right', 'up', 'down'];

        resizeKeys.forEach((key, i) => {
            Main.wm.addKeybinding(
                key,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => {
                    if (!this._resizeManager.isInResizeMode()) return;
                    this._resizeManager.resizeInDirection(resizeDirs[i]);
                }
            );
        });
    }

    get _gap(){
        return this._settings.get_int('gap-size');
    }

    _retileAll(wsIndex) {
        const display = global.display;
        const root = this._tracker.getRootForWorkspace(wsIndex);
        const allTrackedWindows = this._getAllTreeWindows(root);

        console.log(`[Tiler] retileAll: tracked=${allTrackedWindows.length}`);

        display.list_all_windows().forEach(window => {
            if (window.get_workspace()?.index() !== wsIndex) return;
            if (window.get_window_type() !== 0) return;
            if (window.get_maximized() !== 0) return;
            if (window.minimized) return;
            if (window.is_skip_taskbar()) return;
            if (allTrackedWindows.some(w => w === window)) return;

            console.log(`[Tiler] retile: adding untracked "${window.get_title()}"`);
            this._tracker.addWindowToTiling(window);
        });

        this._tileManager._applyLayout(wsIndex);
    }

    _getAllTreeWindows(node) {
        if (!node) return [];
        if (node.type === 'leaf') return [node.window];
        const results = [];
        for (const child of node.children) {
            results.push(...this._getAllTreeWindows(child));
        }
        return results;
    }

    disable() {
        Main.wm.removeKeybinding('retile-windows');
        Main.wm.removeKeybinding('split-horizontal');
        Main.wm.removeKeybinding('split-vertical');
        Main.wm.removeKeybinding('toggle-float');
        Main.wm.removeKeybinding('drag-mode-swap');
        Main.wm.removeKeybinding('drag-mode-insert');

        ['focus-left', 'focus-right', 'focus-up', 'focus-down'].forEach(key => {
            Main.wm.removeKeybinding(key);
        });

        Main.wm.removeKeybinding('toggle-resize-mode');
        ['resize-left', 'resize-right', 'resize-up', 'resize-down'].forEach(key => {
            Main.wm.removeKeybinding(key);
        });
    }
}