from pathlib import Path
import sys

from PIL import Image
from PIL import ImageDraw


COLS = 4
ROWS = 3
BACKGROUND_TOLERANCE = 16


def remove_background(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    mask = Image.new("L", image.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    pixels = image.load()
    visited = set()
    pending = [(0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1)]

    while pending:
        x, y = pending.pop()
        if (x, y) in visited or x < 0 or y < 0 or x >= image.width or y >= image.height:
            continue
        visited.add((x, y))
        red, green, blue, _ = pixels[x, y]
        if max(red, green, blue) - min(red, green, blue) > BACKGROUND_TOLERANCE:
            continue
        mask_draw.point((x, y), fill=255)
        pending.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    alpha = image.getchannel("A")
    alpha = Image.eval(mask, lambda value: 0 if value else 255)
    image.putalpha(alpha)
    return image


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src/frames/happyDuckDance.jpg")
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("src/frames/happyDuck")

    if not source.exists():
        raise SystemExit(f"Sprite sheet not found: {source}")

    image = Image.open(source).convert("RGB")
    cell_width = image.width // COLS
    cell_height = image.height // ROWS
    output_dir.mkdir(parents=True, exist_ok=True)

    for row in range(ROWS):
        for col in range(COLS):
            left = col * cell_width
            top = row * cell_height
            right = (col + 1) * cell_width
            bottom = (row + 1) * cell_height
            frame = image.crop((left, top, right, bottom))
            frame = remove_background(frame)
            frame_number = row * COLS + col + 1
            frame.save(output_dir / f"frame_{frame_number:02d}.png")

    print(f"Wrote {COLS * ROWS} transparent frames ({cell_width}x{cell_height}) to {output_dir}")


if __name__ == "__main__":
    main()