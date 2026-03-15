import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { WindowTracker } from './windowTracker.js';
import { TileManager } from './tileManager.js';

export default class TilerExtension extends Extension {
    enable() {
        this._tracker = new WindowTracker();
        this._tracker.enable();

        this._tileManager = new TileManager(this._tracker);
        this._tileManager.enable();
    }

    disable() {
        this._tileManager.disable();
        this._tileManager = null;

        this._tracker.disable();
        this._tracker = null;
    }
}