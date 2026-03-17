import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keybindings {
    constructor(tileManager, tracker, settings) {
        this._tileManager = tileManager;
        this._tracker = tracker;
        this._settings = settings;
    }

    enable() {
        Main.wm.addKeybinding(
            'retile-windows',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._tileManager._applyLayout(wsIndex);
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
    }

    disable() {
        Main.wm.removeKeybinding('retile-windows');
        Main.wm.removeKeybinding('split-horizontal');
        Main.wm.removeKeybinding('split-vertical');
    }
}