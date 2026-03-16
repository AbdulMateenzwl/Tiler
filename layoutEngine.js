// layoutEngine.js

export class LayoutEngine {
    static calculateColumns(windowsWithRatios, workArea, gap = 8) {
        const count = windowsWithRatios.length;
        if (count === 0) return [];

        if (count === 1) {
            return [{
                window: windowsWithRatios[0].window,
                x: workArea.x + gap,
                y: workArea.y + gap,
                width: workArea.width - gap * 2,
                height: workArea.height - gap * 2,
            }];
        }

        // Normalize ratios on the fly so they always fill the available space
        const totalRatio = windowsWithRatios.reduce((sum, e) => sum + e.widthRatio, 0);

        const totalGaps = gap * (count + 1);
        const availableWidth = workArea.width - totalGaps;
        const colHeight = workArea.height - gap * 2;

        let currentX = workArea.x + gap;

        return windowsWithRatios.map(({ window, widthRatio }) => {
            const normalizedRatio = widthRatio / totalRatio;
            const colWidth = Math.floor(availableWidth * normalizedRatio);
            const result = {
                window,
                x: Math.floor(currentX),
                y: workArea.y + gap,
                width: colWidth,
                height: colHeight,
            };
            currentX += colWidth + gap;
            return result;
        });
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