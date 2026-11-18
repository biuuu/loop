import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Extract the first rounded 10 × 3 set from the supplied multi-style SVG. */
export function extractEmoteVector(source) {
  const definitions = source.match(/<defs>[\s\S]*?<\/defs>/g);
  const groups = source.match(/<g>[\s\S]*?<\/g>/g);
  if (definitions?.length !== 1 || groups?.length !== 1)
    throw new Error('Expected one definitions block and one plain path group');
  const group = groups[0].slice(3, -4);
  const paths = group.match(/<path\b[^>]*\/>/g) ?? [];
  if (group.replace(/<path\b[^>]*\/>/g, '').trim())
    throw new Error('Unexpected content in the source path group');

  const selected = [];
  const cells = new Set();
  for (const path of paths) {
    const data = path.match(/\bd="([^"]*)"/)?.[1];
    if (!data || !data.startsWith('M'))
      throw new Error('Expected an absolute M/L/Q path');
    const numbers = data.match(/-?\d+(?:\.\d+)?/g) ?? [];
    if (data.replace(/-?\d+(?:\.\d+)?|[MLQ\s,]/g, ''))
      throw new Error('Unsupported path command or coordinate');
    const coordinates = numbers.map(Number);
    if (
      coordinates.length === 0 ||
      coordinates.length % 2 !== 0 ||
      coordinates.some((value) => !Number.isFinite(value))
    )
      throw new Error('Expected finite coordinate pairs');
    for (const command of data.matchAll(/([MLQ])([^MLQ]*)/g)) {
      const count = command[2].match(/-?\d+(?:\.\d+)?/g)?.length ?? 0;
      if (count === 0 || count % (command[1] === 'Q' ? 4 : 2) !== 0)
        throw new Error('Invalid M/L/Q coordinate count');
    }
    const xs = coordinates.filter((_, index) => index % 2 === 0);
    const ys = coordinates.filter((_, index) => index % 2 === 1);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // Later pixel/style samples begin below this first three-row region.
    if (minY >= 140) continue;
    const column = Math.floor((minX - 16) / 40);
    const row = Math.floor((minY - 20) / 40);
    if (
      column < 0 ||
      column >= 10 ||
      row < 0 ||
      row >= 3 ||
      minX < 20 ||
      maxX > 412 ||
      minY < 20 ||
      maxY > 138 ||
      maxX >= 16 + (column + 1) * 40 ||
      maxY >= 20 + (row + 1) * 40
    )
      throw new Error('Front path crosses an expected emote cell');
    selected.push(path);
    cells.add(`${column},${row}`);
  }
  if (selected.length !== 96 || cells.size !== 30)
    throw new Error('Expected 96 front paths covering all 30 emote cells');

  // Six raster pixels per source unit give Pixi a generous intrinsic texture.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="720" viewBox="16 20 400 120" overflow="hidden">\n  ${definitions[0]}\n  <g>\n${selected.map((path) => `    ${path}`).join('\n')}\n  </g>\n</svg>\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const source = new URL('../public/emotes/emotes_vector.svg', import.meta.url);
  const target = new URL(
    '../public/emotes/emotes_vector-front.svg',
    import.meta.url,
  );
  writeFileSync(target, extractEmoteVector(readFileSync(source, 'utf8')));
}
