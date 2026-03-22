import { ContainerTree } from './containerTree.js';
import { LayoutEngine } from './layoutEngine.js';
import GLib from 'gi://GLib';

// --- Config ---
const TERM_WIDTH = 120;
const TERM_HEIGHT = 36;

// --- Tree printer ---
function printTree(node, prefix = '', isLast = true, layout = null) {
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.type === 'leaf') {
        const pos = layout?.find(l => l.window === node.window);
        const sizeStr = pos
            ? ` [${pos.x},${pos.y} ${pos.width}x${pos.height}]`
            : ` [collapsed]`;
        print(`${prefix}${connector}LEAF "${node.window.title}" ratio=${node.ratio.toFixed(3)}${sizeStr} id=${node.id}`);
    } else {
        print(`${prefix}${connector}${node.direction.toUpperCase()} ratio=${node.ratio.toFixed(3)} id=${node.id}`);
        node.children.forEach((child, i) => {
            printTree(child, prefix + childPrefix, i === node.children.length - 1, layout);
        });
    }
}

function showTree(tree, wsIndex = 0) {
    const root = tree.getRoot(wsIndex);
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const layout = LayoutEngine.calculate(root, workArea, 8);

    print(`\nWorkspace ${wsIndex} tree:`);
    print(`ROOT HORIZONTAL`);
    root.children.forEach((child, i) => {
        printTree(child, '', i === root.children.length - 1, layout);
    });
    print('');
}

// --- Tmux-style visual renderer ---
function renderLayout(tree, wsIndex = 0) {
    const root = tree.getRoot(wsIndex);
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const layout = LayoutEngine.calculate(root, workArea, 8);

    if (layout.length === 0) {
        print('(empty workspace)');
        return;
    }

    // Scale real pixel coords to terminal size
    const scaleX = w => Math.floor((w / 1920) * TERM_WIDTH);
    const scaleY = h => Math.floor((h / 1080) * TERM_HEIGHT);

    // Build a 2D character grid
    const grid = [];
    for (let y = 0; y < TERM_HEIGHT; y++) {
        grid.push(new Array(TERM_WIDTH).fill(' '));
    }

    function setChar(x, y, ch) {
        if (x >= 0 && x < TERM_WIDTH && y >= 0 && y < TERM_HEIGHT) {
            grid[y][x] = ch;
        }
    }

    function hLine(x1, x2, y, ch = '─') {
        for (let x = x1; x <= x2; x++) setChar(x, y, ch);
    }

    function vLine(y1, y2, x, ch = '│') {
        for (let y = y1; y <= y2; y++) setChar(x, y, ch);
    }

    function drawBox(tx, ty, tw, th, title) {
        if (tw < 2 || th < 2) return;

        // Corners
        setChar(tx, ty, '┌');
        setChar(tx + tw - 1, ty, '┐');
        setChar(tx, ty + th - 1, '└');
        setChar(tx + tw - 1, ty + th - 1, '┘');

        // Edges
        hLine(tx + 1, tx + tw - 2, ty, '─');
        hLine(tx + 1, tx + tw - 2, ty + th - 1, '─');
        vLine(ty + 1, ty + th - 2, tx, '│');
        vLine(ty + 1, ty + th - 2, tx + tw - 1, '│');

        // Title centered on top border
        const maxTitleLen = tw - 4;
        const label = title.length > maxTitleLen
            ? title.slice(0, maxTitleLen - 1) + '…'
            : title;
        const startX = tx + Math.floor((tw - label.length) / 2);
        for (let i = 0; i < label.length; i++) {
            setChar(startX + i, ty, label[i]);
        }

        // Window size info centered in middle of box
        const sizeInfo = `${tw}×${th}`;
        if (th > 2 && tw > sizeInfo.length + 2) {
            const midY = ty + Math.floor(th / 2);
            const midX = tx + Math.floor((tw - sizeInfo.length) / 2);
            for (let i = 0; i < sizeInfo.length; i++) {
                setChar(midX + i, midY, sizeInfo[i]);
            }
        }
    }

    // Draw each window
    layout.forEach(({ window, x, y, width, height }) => {
        const tx = scaleX(x);
        const ty = scaleY(y);
        const tw = Math.max(2, scaleX(x + width) - tx);
        const th = Math.max(2, scaleY(y + height) - ty);
        drawBox(tx, ty, tw, th, window.title);
    });

    // Print the grid
    print('\n' + '─'.repeat(TERM_WIDTH));
    grid.forEach(row => print(row.join('')));
    print('─'.repeat(TERM_WIDTH) + '\n');
}

// --- Helpers ---
function getAllWindows(node) {
    if (node.type === 'leaf') return [node.window];
    return node.children.flatMap(c => getAllWindows(c));
}

function readLine() {
    const stdin = GLib.IOChannel.unix_new(0);
    stdin.set_encoding('utf-8');
    const [, str] = stdin.read_line();
    return str?.trim() ?? '';
}

function interactiveAdd(tree, ws) {
    renderLayout(tree, ws);
    showTree(tree, ws);

    print('Window title to add:');
    const title = readLine();
    if (!title) return;
    const newWindow = { title };

    const allWindows = getAllWindows(tree.getRoot(ws));
    print('\nAvailable windows in tree:');
    allWindows.forEach((w, i) => print(`  ${i}: "${w.title}"`));
    print('  (enter nothing to add to root)');

    print('\nFocus window index (or enter for root):');
    const focusInput = readLine();
    const focusedWindow = focusInput !== ''
        ? allWindows[parseInt(focusInput)]
        : null;

    print('\nSplit direction: h = horizontal, v = vertical, enter = default');
    const dirInput = readLine();

    if (dirInput === 'v') {
        tree.setPendingSplit(ws, 'vertical');
    } else if (dirInput === 'h') {
        tree.setPendingSplit(ws, 'horizontal');
    }

    tree.insertWindow(newWindow, ws, focusedWindow);
    print(`\nAdded "${title}" successfully.`);
}

function interactiveRemove(tree, ws) {
    renderLayout(tree, ws);
    showTree(tree, ws);

    const allWindows = getAllWindows(tree.getRoot(ws));
    if (allWindows.length === 0) {
        print('No windows to remove.');
        return;
    }

    print('Available windows:');
    allWindows.forEach((w, i) => print(`  ${i}: "${w.title}"`));

    print('\nWindow index to remove:');
    const input = readLine();
    if (input === '') return;

    const idx = parseInt(input);
    if (isNaN(idx) || idx < 0 || idx >= allWindows.length) {
        print('Invalid index.');
        return;
    }

    const window = allWindows[idx];
    tree.removeWindow(window, ws);
    print(`\nRemoved "${window.title}" successfully.`);

    renderLayout(tree, ws);
    showTree(tree, ws);
}

function interactiveCollapse(tree, ws) {
    renderLayout(tree, ws);
    showTree(tree, ws);

    const allWindows = getAllWindows(tree.getRoot(ws));
    if (allWindows.length === 0) {
        print('No windows to collapse.');
        return;
    }

    print('Available windows:');
    allWindows.forEach((w, i) => print(`  ${i}: "${w.title}"`));

    print('\nWindow index to collapse:');
    const input = readLine();
    if (input === '') return;

    const idx = parseInt(input);
    if (isNaN(idx) || idx < 0 || idx >= allWindows.length) {
        print('Invalid index.');
        return;
    }

    const window = allWindows[idx];
    tree.collapseNode(window, ws);
    print(`\nCollapsed "${window.title}" — ratio set to 0, siblings redistributed.`);

    renderLayout(tree, ws);
    showTree(tree, ws);
}

function interactiveRestore(tree, ws) {
    renderLayout(tree, ws);
    showTree(tree, ws);

    // Show all windows including collapsed ones
    const allWindows = getAllWindowsIncludingCollapsed(tree.getRoot(ws));
    const collapsed = allWindows.filter(w => {
        const leaf = tree.findLeaf(w, tree.getRoot(ws));
        return leaf && leaf.ratio === 0;
    });

    if (collapsed.length === 0) {
        print('No collapsed windows to restore.');
        return;
    }

    print('Collapsed windows:');
    collapsed.forEach((w, i) => print(`  ${i}: "${w.title}"`));

    print('\nWindow index to restore:');
    const input = readLine();
    if (input === '') return;

    const idx = parseInt(input);
    if (isNaN(idx) || idx < 0 || idx >= collapsed.length) {
        print('Invalid index.');
        return;
    }

    const window = collapsed[idx];
    tree.restoreNode(window, ws);
    print(`\nRestored "${window.title}" — ratio and siblings restored from snapshot.`);

    renderLayout(tree, ws);
    showTree(tree, ws);
}

function interactiveResize(tree, ws) {
    renderLayout(tree, ws);
    showTree(tree, ws);

    const allWindows = getAllWindows(tree.getRoot(ws));
    if (allWindows.length === 0) {
        print('No windows to resize.');
        return;
    }

    print('Available windows:');
    allWindows.forEach((w, i) => print(`  ${i}: "${w.title}"`));

    print('\nWindow index to resize:');
    const idxInput = readLine();
    if (idxInput === '') return;

    const idx = parseInt(idxInput);
    if (isNaN(idx) || idx < 0 || idx >= allWindows.length) {
        print('Invalid index.');
        return;
    }

    const window = allWindows[idx];
    const root = tree.getRoot(ws);
    const leaf = tree.findLeaf(window, root);
    if (!leaf) {
        print('Leaf not found.');
        return;
    }

    const parent = tree.findParent(leaf.id, root) ?? root;
    const visibleSiblings = parent.children.filter(c => c.ratio > 0);

    print(`\nCurrent ratios in container (${parent.direction}):`);
    visibleSiblings.forEach(c => {
        const title = c.type === 'leaf' ? `"${c.window.title}"` : `[${c.direction} container]`;
        const marker = c === leaf ? ' ← target' : '';
        print(`  ${title}: ${c.ratio.toFixed(4)}${marker}`);
    });

    print(`\nNew ratio for "${window.title}" (current: ${leaf.ratio.toFixed(4)}):`);
    print('  e.g. 0.5 for half, 0.25 for quarter');
    const ratioInput = readLine();
    if (ratioInput === '') return;

    const newRatio = parseFloat(ratioInput);
    if (isNaN(newRatio) || newRatio <= 0 || newRatio >= 1) {
        print('Invalid ratio. Must be between 0 and 1 exclusive.');
        return;
    }

    print('\nWhich side to take space from?');
    print('  r = right/below siblings');
    print('  l = left/above siblings');
    const sideInput = readLine();
    const side = sideInput === 'l' ? 'left' : 'right';

    const oldRatio = leaf.ratio;
    const delta = newRatio - oldRatio;
    const neighbours = side === 'right'
        ? visibleSiblings.filter((_, i) => i > visibleSiblings.indexOf(leaf))
        : visibleSiblings.filter((_, i) => i < visibleSiblings.indexOf(leaf));

    if (neighbours.length === 0) {
        print(`No ${side} neighbours to take space from.`);
        return;
    }

    const perNeighbour = delta / neighbours.length;
    leaf.ratio = newRatio;
    neighbours.forEach(n => n.ratio -= perNeighbour);

    print(`\nResized "${window.title}" from ${oldRatio.toFixed(4)} to ${newRatio.toFixed(4)}.`);
    print(`Each of ${neighbours.length} ${side} neighbour(s) changed by ${(-perNeighbour).toFixed(4)}.`);

    renderLayout(tree, ws);
    showTree(tree, ws);
}

function getAllWindowsIncludingCollapsed(node) {
    if (node.type === 'leaf') return [node.window];
    return node.children.flatMap(c => getAllWindowsIncludingCollapsed(c));
}

// --- Main ---
const tree = new ContainerTree();
const ws = 0;

tree.insertWindow({ title: 'A' }, ws, null);
tree.insertWindow({ title: 'B' }, ws, { title: 'A' });
tree.insertWindow({ title: 'C' }, ws, { title: 'B' });

print('\nPress Ctrl+C to exit\n');
while (true) {

    print('Action: a=add  r=remove  c=collapse  s=restore  z=resize');
    const action = readLine();

    if (action === 'a') {
        interactiveAdd(tree, ws);
    } else if (action === 'r') {
        interactiveRemove(tree, ws);
    } else if (action === 'c') {
        interactiveCollapse(tree, ws);
    } else if (action === 's') {
        interactiveRestore(tree, ws);
    } else if (action === 'z') {
        interactiveResize(tree, ws);
    } else if (action === 'w') {
        print('Current state:');
        renderLayout(tree, ws);
        showTree(tree, ws);
    }
    else {
        print('Unknown action.');
    }
}