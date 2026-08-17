from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "branding" / "app-icon-source.png"


def rounded_mask(size: tuple[int, int], inset: int, radius: int, feather: float = 1.5) -> Image.Image:
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (inset, inset, width - inset - 1, height - inset - 1),
        radius=radius,
        fill=255,
    )
    return mask.filter(ImageFilter.GaussianBlur(feather)) if feather else mask


def circle_mask(size: tuple[int, int], inset: int = 0, feather: float = 1.0) -> Image.Image:
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((inset, inset, width - inset - 1, height - inset - 1), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(feather)) if feather else mask


def with_alpha(image: Image.Image, mask: Image.Image) -> Image.Image:
    result = image.convert("RGBA")
    current = result.getchannel("A")
    result.putalpha(ImageChops.darker(current, mask))
    return result


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG", optimize=True)


def save_webp(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "WEBP", lossless=True, method=6)


def centered_layer(canvas_size: int, art: Image.Image, art_size: int, color: str) -> Image.Image:
    canvas = Image.new("RGBA", (canvas_size, canvas_size), color)
    scaled = art.resize((art_size, art_size), Image.Resampling.LANCZOS)
    offset = (canvas_size - art_size) // 2
    canvas.alpha_composite(scaled, (offset, offset))
    return canvas


def preview_panel(icon: Image.Image, label: str, mask: Image.Image | None = None) -> Image.Image:
    panel = Image.new("RGBA", (300, 330), "#EEF3FA")
    tile = icon.resize((256, 256), Image.Resampling.LANCZOS)
    if mask is not None:
        tile = with_alpha(tile, mask)
    panel.alpha_composite(tile, (22, 18))
    draw = ImageDraw.Draw(panel)
    draw.text((22, 292), label, fill="#16345B")
    return panel


def make_preview(master: Image.Image, adaptive: Image.Image) -> Image.Image:
    panels: Iterable[Image.Image] = (
        preview_panel(master, "Legacy rounded square"),
        preview_panel(master, "Round launcher", circle_mask((256, 256), inset=2)),
        preview_panel(adaptive, "Adaptive circle mask", circle_mask((256, 256), inset=2)),
    )
    sheet = Image.new("RGBA", (940, 350), "#DCE8F7")
    for index, panel in enumerate(panels):
        sheet.alpha_composite(panel, (10 + index * 310, 10))
    return sheet


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    source_mask = rounded_mask(source.size, inset=24, radius=142, feather=1.8)
    clipped = with_alpha(source, source_mask)
    master = clipped.resize((1024, 1024), Image.Resampling.LANCZOS)

    save_png(master, ROOT / "docs" / "branding" / "app-icon-master.png")
    save_png(master.resize((512, 512), Image.Resampling.LANCZOS), ROOT / "plugin" / "dist" / "icon-512.png")
    save_png(master.resize((192, 192), Image.Resampling.LANCZOS), ROOT / "plugin" / "dist" / "icon-192.png")

    maskable = centered_layer(512, master, 420, "#5A9FF3")
    save_png(maskable, ROOT / "plugin" / "dist" / "icon-maskable-512.png")

    density_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in density_sizes.items():
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        round_icon = with_alpha(icon, circle_mask((size, size), inset=max(1, size // 96)))
        resource_dir = ROOT / "android" / "app" / "src" / "main" / "res" / folder
        save_webp(icon, resource_dir / "ic_launcher.webp")
        save_webp(round_icon, resource_dir / "ic_launcher_round.webp")

    adaptive_foreground = centered_layer(432, master, 356, "#00000000")
    save_png(
        adaptive_foreground,
        ROOT / "android" / "app" / "src" / "main" / "res" / "mipmap-xxxhdpi" / "ic_launcher_whale_foreground.png",
    )

    adaptive_preview = centered_layer(1024, master, 844, "#5A9FF3")
    save_png(make_preview(master, adaptive_preview), ROOT / "docs" / "branding" / "app-icon-preview.png")


if __name__ == "__main__":
    main()
