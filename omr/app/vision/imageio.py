"""사진 파일 읽기: JPEG/PNG/HEIC/PDF(첫 쪽 이미지), 회전 정보 반영, 촬영 시각 추출."""
import io
from datetime import datetime

import numpy as np
from PIL import ExifTags, Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC 없이도 나머지는 동작
    pillow_heif = None

DATETIME_ORIGINAL = 36867
EXIF_IFD = 0x8769


def _from_pdf(data: bytes) -> Image.Image:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    page = doc[0]
    images = page.get_images(full=True)
    if images:
        # 사진을 PDF로 저장한 경우: 들어 있는 원본 이미지를 그대로 꺼낸다
        xref = max(images, key=lambda im: im[2] * im[3])[0]
        return Image.open(io.BytesIO(doc.extract_image(xref)["image"]))
    pix = page.get_pixmap(dpi=300)
    return Image.open(io.BytesIO(pix.tobytes("png")))


def load_image(data: bytes) -> tuple[np.ndarray, datetime | None]:
    """바이트 → (BGR 이미지, 촬영 시각 또는 None)."""
    if data[:5] == b"%PDF-":
        img = _from_pdf(data)
    else:
        img = Image.open(io.BytesIO(data))
    taken = None
    try:
        exif = img.getexif()
        raw = exif.get_ifd(EXIF_IFD).get(DATETIME_ORIGINAL) or exif.get(ExifTags.Base.DateTime)
        if raw:
            taken = datetime.strptime(str(raw).strip("\x00 ")[:19], "%Y:%m:%d %H:%M:%S")
    except Exception:
        taken = None
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.asarray(img)[:, :, ::-1].copy()  # RGB → BGR (OpenCV)
    return arr, taken
