import {
  CAT_CELL_SIZE,
  CAT_IDLE_UP_COLUMN,
  type CatAnimation,
} from './cat-sprite';

export const SEAL_POINT_SAMPLE = {
  coat: 'cream',
  pattern: 'seal_point_sample',
} as const;

// Frame-local markings for the two poses shown in the wardrobe. A plus is
// the softer face mask and a hash is the darker color on the extremities.
const ears = { x: 26, y: 32, rows: ['##.....##', '##.....##', '.#.....#.'] };
const poses = {
  idle: [
    ears,
    {
      x: 27,
      y: 36,
      rows: ['.+++++.', '+.+++.+', '+.+++.+', '+++++++', '.+++++.'],
    },
    {
      x: 39,
      y: 38,
      rows: ['..#.', '..#.', '...#', '...#', '..#.', '.##.', '##..', '#...'],
    },
    { x: 27, y: 45, rows: ['#..##..##.', '#.##...###'] },
  ],
  sleep: [
    { ...ears, y: 36 },
    {
      x: 27,
      y: 40,
      rows: ['.+++++..', '..++..++', '++++++++', '+++++++.', '..+++...'],
    },
    {
      x: 40,
      y: 44,
      rows: ['##....', '..###.', '.....#', '.....#', '.....#', '...##.'],
    },
    { x: 26, y: 46, rows: ['##.......##'] },
  ],
};

export function sealPointSampleMask(animation: CatAnimation, column: number) {
  if (animation !== 'idle' && animation !== 'sleep') return;
  if (column !== (animation === 'idle' ? CAT_IDLE_UP_COLUMN : 0)) return;
  const mask = new Uint8Array(CAT_CELL_SIZE * CAT_CELL_SIZE);
  for (const { x, y, rows } of poses[animation]) {
    for (const [dy, row] of rows.entries()) {
      for (let dx = 0; dx < row.length; dx++) {
        const pixel = (y + dy) * CAT_CELL_SIZE + x + dx;
        if (row[dx] === '+') mask[pixel] = 1;
        if (row[dx] === '#') mask[pixel] = 2;
      }
    }
  }
  return mask;
}
