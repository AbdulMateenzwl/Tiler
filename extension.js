import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { WindowTracker } from './windowTracker.js';
import { TileManager } from './tileManager.js';
import { Keybindings } from './keybindings.js';

export default class TilerExtension extends Extension {
    enable() {
        const settings = this.getSettings('org.gnome.shell.extensions.tiler');

        this._tracker = new WindowTracker();
        this._tracker.enable();

        this._tileManager = new TileManager(this._tracker);
        this._tileManager.enable();

        this._keybindings = new Keybindings(this._tileManager, this._tracker, settings);
        this._keybindings.enable();
    }

    disable() {
        this._keybindings.disable();
        this._keybindings = null;

        this._tileManager.disable();
        this._tileManager = null;

        this._tracker.disable();
        this._tracker = null;
    }
}