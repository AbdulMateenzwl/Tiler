import { ContainerTree } from './containerTree.js';
import { LayoutEngine } from './layoutEngine.js';

const tree = new ContainerTree();
const ws = 0;
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

const winA = { title: 'A' };
const winB = { title: 'B' };
const winC = { title: 'C' };

// Add A, B, C as siblings
tree.insertWindow(winA, ws, null);
tree.insertWindow(winB, ws, winA);
tree.insertWindow(winC, ws, winB);

console.log('--- A B C equal columns ---');
LayoutEngine.calculate(tree.getRoot(ws), workArea, 8)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} w=${l.width}`));

// Collapse B (minimize)
tree.collapseNode(winB, ws);

console.log('--- B collapsed, A and C should fill space ---');
LayoutEngine.calculate(tree.getRoot(ws), workArea, 8)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} w=${l.width}`));

// Restore B
tree.restoreNode(winB, ws);

console.log('--- B restored, should be back between A and C ---');
LayoutEngine.calculate(tree.getRoot(ws), workArea, 8)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} w=${l.width}`));
