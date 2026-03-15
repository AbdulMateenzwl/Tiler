import { LayoutEngine } from './layoutEngine.js';

const workArea = {x: 0, y: 0, width: 1920, height: 1080};

console.log('--- 1 window ---');
LayoutEngine.calculateColumns([{title:'w1'}], workArea, 8)
    .forEach(l => console.log(JSON.stringify(l)));

console.log('--- 2 windows ---');
LayoutEngine.calculateColumns([{title:'w1'},{title:'w2'}], workArea, 8)
    .forEach(l => console.log(JSON.stringify(l)));

console.log('--- 3 windows ---');
LayoutEngine.calculateColumns([{title:'w1'},{title:'w2'},{title:'w3'}], workArea, 8)
    .forEach(l => console.log(JSON.stringify(l)));
