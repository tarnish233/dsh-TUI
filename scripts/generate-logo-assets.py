#!/usr/bin/env python3
"""Generate the static blue/white character logo from the reference image.

Development-only Pillow processing. The runtime renders `grid.json` as block
characters on every terminal; no image protocol is involved.

The grid stores one sample per quadrant sub-cell, so 32 x 12 samples become
16 x 6 terminal cells. Quadrant glyphs keep every sample half a cell wide and
half a cell tall, i.e. quarter-size pixels of the old half-block rendering.
Enclosed transparent logo regions are white; the outside stays transparent.
The almost flat reference crown gets a shallow documented arc so the head does
not read as cut off at this resolution.
"""
import argparse
import json
from collections import deque
from pathlib import Path
from PIL import Image

COLUMNS = 32
PIXEL_ROWS = 12
CELL_COLUMNS = COLUMNS // 2
CELL_ROWS = PIXEL_ROWS // 2
# Only the blue/white tags are emitted. The runtime paints the brand hue from
# src/ui/brand.ts (src/ui/logo.ts), so no color belongs in this asset.

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('--output', type=Path,
                    default=Path(__file__).resolve().parent.parent / 'assets/logo')
args = parser.parse_args()

source = Image.open(args.source).convert('RGB')
mask = Image.new('L', source.size)
values = []
for r, g, b in source.get_flattened_data():
    alpha = max(0, min(1, ((b - r - 5) / 168 + (b - g - 3) / 128) / 2))
    values.append(round(255 * alpha) if alpha > 0.08 else 0)
mask.putdata(values)
bounds = mask.getbbox()
if bounds is None:
    raise ValueError('No blue DeepSeek logo silhouette found')
mask = mask.crop(bounds)

# Each sample is half a cell wide and one half-cell tall, so the sample grid is
# stretched to 32 x 12 to keep the source aspect ratio in terminal cells.
small = mask.resize((COLUMNS, PIXEL_ROWS), Image.Resampling.BOX)
small = small.point(lambda alpha: 255 if alpha >= 110 else 0)
blue = [[small.getpixel((x, y)) >= 128 for x in range(COLUMNS)]
        for y in range(PIXEL_ROWS)]

outer, queue = set(), deque()
for y in range(PIXEL_ROWS):
    for x in range(COLUMNS):
        if (x in (0, COLUMNS - 1) or y in (0, PIXEL_ROWS - 1)) and not blue[y][x]:
            outer.add((x, y))
            queue.append((x, y))
while queue:
    x, y = queue.popleft()
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < COLUMNS and 0 <= ny < PIXEL_ROWS and not blue[ny][nx] and (nx, ny) not in outer:
            outer.add((nx, ny))
            queue.append((nx, ny))

rows = [''.join('B' if blue[y][x] else '.' if (x, y) in outer else 'W'
                for x in range(COLUMNS)) for y in range(PIXEL_ROWS)]

# The reference crown is almost flat, which reads as a cut-off head at this
# resolution. Raise the middle third of the topmost crown run by one sample
# (half a cell) on whole cell boundaries, so the head gets a shallow arc without the
# diagonal notch a per-sample profile would leave at the top-left shoulder.
# Only row 0 gains blue samples; blowhole/spout peaks and white interior
# samples are never touched.
def longest_run(row):
    best = (0, 0)
    start = None
    for x, tag in enumerate(row + '.'):
        if tag == 'B' and start is None:
            start = x
        elif tag != 'B' and start is not None:
            if x - start > best[1] - best[0]:
                best = (start, x)
            start = None
    return best

cells = [list(row) for row in rows]
crown_start, crown_end = longest_run(rows[1])
first_cell = (crown_start + 1) // 2
last_cell = crown_end // 2
span = last_cell - first_cell
raise_cells = max(2, round(span * 0.34))
raise_from = first_cell + (span - raise_cells) // 2
for cx in range(raise_from, raise_from + raise_cells):
    for x in (cx * 2, cx * 2 + 1):
        if cells[0][x] == '.':
            cells[0][x] = 'B'
rows = [''.join(row) for row in cells]

# A terminal cell carries a foreground and one background color. Reject data
# that would need three states (blue, white and transparent) in one cell.
for cy in range(CELL_ROWS):
    for cx in range(CELL_COLUMNS):
        tags = {rows[cy * 2 + dy][cx * 2 + dx] for dy in range(2) for dx in range(2)}
        if len(tags) > 2 or ('.' in tags and len(tags) == 2 and 'W' in tags):
            raise ValueError('Ambiguous quadrant cell at %d,%d: %s' % (cx, cy, sorted(tags)))

args.output.mkdir(parents=True, exist_ok=True)
(args.output / 'grid.json').write_text(json.dumps({
    'source': 'Directly sampled DeepSeek logo reference; enclosed negative spaces filled white; crown arc gently rounded',
    'columns': COLUMNS, 'pixelRows': PIXEL_ROWS,
    'rows': rows,
}, indent=2) + '\n')
print(json.dumps({'columns': COLUMNS, 'pixelRows': PIXEL_ROWS,
                  'cellColumns': CELL_COLUMNS, 'cellRows': CELL_ROWS,
                  'whitePixels': sum(row.count('W') for row in rows)}))