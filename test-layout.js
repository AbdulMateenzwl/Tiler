import { LayoutEngine } from './layoutEngine.js';

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const gap = 8;

// Test 1 — three equal columns (current behaviour)
const tree1 = {
    type: 'container',
    direction: 'horizontal',
    ratio: 1.0,
    children: [
        { type: 'leaf', ratio: 1, window: { title: 'A' } },
        { type: 'leaf', ratio: 1, window: { title: 'B' } },
        { type: 'leaf', ratio: 1, window: { title: 'C' } },
    ]
};

console.log('--- Test 1: three equal columns ---');
LayoutEngine.calculate(tree1, workArea, gap)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} y=${l.y} w=${l.width} h=${l.height}`));

// Test 2 — A on left, B and C stacked on right
const tree2 = {
    type: 'container',
    direction: 'horizontal',
    ratio: 1.0,
    children: [
        { type: 'leaf', ratio: 1, window: { title: 'A' } },
        {
            type: 'container',
            direction: 'vertical',
            ratio: 1,
            children: [
                { type: 'leaf', ratio: 1, window: { title: 'B' } },
                { type: 'leaf', ratio: 1, window: { title: 'C' } },
            ]
        }
    ]
};

console.log('--- Test 2: A left, B+C stacked right ---');
LayoutEngine.calculate(tree2, workArea, gap)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} y=${l.y} w=${l.width} h=${l.height}`));

// Test 3 — deeply nested
const tree3 = {
    type: 'container',
    direction: 'horizontal',
    ratio: 1.0,
    children: [
        { type: 'leaf', ratio: 1, window: { title: 'A' } },
        {
            type: 'container',
            direction: 'vertical',
            ratio: 1,
            children: [
                { type: 'leaf', ratio: 1, window: { title: 'B' } },
                {
                    type: 'container',
                    direction: 'horizontal',
                    ratio: 1,
                    children: [
                        { type: 'leaf', ratio: 1, window: { title: 'C' } },
                        { type: 'leaf', ratio: 1, window: { title: 'D' } },
                    ]
                },
            ]
        }
    ]
};

console.log('--- Test 3: A left, B top-right, C+D bottom-right ---');
LayoutEngine.calculate(tree3, workArea, gap)
    .forEach(l => console.log(`${l.window.title}: x=${l.x} y=${l.y} w=${l.width} h=${l.height}`));
