// layoutEngine.js

export class LayoutEngine {
    /**
         * Column layout — each window gets an equal vertical strip.
         * @param {Meta.Window[]} windows
         * @param {{x, y, width, height}} workArea
         * @param {number} gap
         * @returns {{window, x, y, width, height}[]}
         */
    static calculateColumns(windows, workArea, gap = 8) {
        const count = windows.length;
        if (count === 0) return [];

        if (count === 1) {
            return [{
                window: windows[0],
                x: workArea.x + gap,
                y: workArea.y + gap,
                width: workArea.width - gap * 2,
                height: workArea.height - gap * 2,
            }];
        }

        const totalGaps = gap * (count + 1);
        const colWidth = Math.floor((workArea.width - totalGaps) / count);
        const colHeight = workArea.height - gap * 2;

        return windows.map((window, i) => ({
            window,
            x: workArea.x + gap + i * (colWidth + gap),
            y: workArea.y + gap,
            width: colWidth,
            height: colHeight,
        }));
    }

    /**
     * Get the work area for a given workspace index.
     */
    static getWorkArea(wsIndex) {
        const workspace = global.workspace_manager.get_workspace_by_index(wsIndex);
        const monitor = global.display.get_primary_monitor();
        return workspace.get_work_area_for_monitor(monitor);
    }

}