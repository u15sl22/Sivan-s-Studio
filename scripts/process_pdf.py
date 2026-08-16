"""Render a children's-book PDF or PNG and recognize its reading text."""

from __future__ import annotations

import json
import pathlib
import re
import sys

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL_PACKAGES = PROJECT_ROOT / ".python-packages"
if LOCAL_PACKAGES.exists():
    sys.path.insert(0, str(LOCAL_PACKAGES))

import pypdfium2 as pdfium
from PIL import Image, ImageEnhance

_ocr_engine = None


def normalize_text(value: str) -> str:
    return " ".join(value.replace("\r", "\n").split())


def recognize_image(image_path: pathlib.Path) -> str:
    """OCR a rendered page when the PDF has no usable embedded text layer."""
    global _ocr_engine
    if _ocr_engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as error:
            raise RuntimeError("OCR engine is unavailable; install rapidocr_onnxruntime") from error
        _ocr_engine = RapidOCR()

    # Grayscale + contrast helps with the colored initial letters commonly used
    # in early-reader books (for example a red "B" followed by black text).
    image = Image.open(image_path).convert("L")
    image = ImageEnhance.Contrast(image).enhance(1.5)
    result, _elapsed = _ocr_engine(image)
    if not result:
        return ""
    lines = []
    for line in result:
        if len(line) <= 1:
            continue
        value = normalize_text(str(line[1]))
        # Page numbers are navigation, not words the student should read.
        if not value or re.fullmatch(r"[0-9一二三四五六七八九十]+", value):
            continue
        lines.append(value)
    cleaned = normalize_text(" ".join(lines))
    # Early-reader alphabet books often color the initial letter separately.
    # Prefer the complete "B is for ..." sentence when surrounding artwork
    # produces stray OCR symbols.
    early_reader = re.search(r"(?:^|\s)([A-Za-z]\s+is\s+for\b.*?[.!?])(?=\s|$)", cleaned, re.IGNORECASE)
    return early_reader.group(1) if early_reader else cleaned


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: process_pdf.py INPUT_FILE OUTPUT_DIR")

    source = pathlib.Path(sys.argv[1]).resolve()
    output_dir = pathlib.Path(sys.argv[2]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    temporary_manifest_path = output_dir / "manifest.json.tmp"
    temporary_manifest_path.unlink(missing_ok=True)

    pages: list[dict[str, object]] = []

    if source.suffix.lower() == ".png":
        filename = "page-0001.jpg"
        destination = output_dir / filename
        with Image.open(source) as source_image:
            image = source_image.convert("RGB")
            image.save(destination, format="JPEG", quality=88, optimize=True)
        text = recognize_image(destination)
        pages.append({"index": 0, "image": filename, "text": text, "textSource": "ocr" if text else "none"})
    else:
        document = pdfium.PdfDocument(str(source))
        for index in range(len(document)):
            page = document[index]
            filename = f"page-{index + 1:04d}.jpg"
            destination = output_dir / filename

            bitmap = page.render(scale=1.8)
            image = bitmap.to_pil().convert("RGB")
            image.save(destination, format="JPEG", quality=88, optimize=True)

            text_page = page.get_textpage()
            text = normalize_text(text_page.get_text_range())
            text_source = "embedded"
            if not text:
                text = recognize_image(destination)
                text_source = "ocr" if text else "none"
            pages.append({"index": index, "image": filename, "text": text, "textSource": text_source})

            text_page.close()
            page.close()
        document.close()
    manifest = {"complete": True, "source": source.name, "pageCount": len(pages), "pages": pages}
    temporary_manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    temporary_manifest_path.replace(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
