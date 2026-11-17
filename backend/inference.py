import base64
import binascii
import io
import logging
import os
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from ultralytics import YOLO

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "models" / "best.pt"
logger = logging.getLogger(__name__)


class InferenceRequest(BaseModel):
    image: str
    conf_threshold: float = Field(default=0.25, ge=0.0, le=1.0)


@lru_cache(maxsize=1)
def get_model() -> YOLO:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model not found at {MODEL_PATH}")

    model = YOLO(str(MODEL_PATH))
    class_names = getattr(model, "names", {})
    if not class_names:
        raise RuntimeError("Model metadata did not expose class names.")
    return model


def decode_base64_image(image_payload: str) -> Image.Image:
    if not image_payload:
        raise ValueError("The request did not include an image payload.")

    if image_payload.startswith("data:image"):
        header, encoded = image_payload.split(",", 1)
        if ";base64" not in header:
            raise ValueError("Only base64-encoded data URLs are supported.")
        decoded = base64.b64decode(encoded, validate=True)
    else:
        decoded = base64.b64decode(image_payload, validate=True)

    image = Image.open(io.BytesIO(decoded)).convert("RGB")
    return image


def predict_from_image(image_payload: str, conf_threshold: float = 0.25):
    image = decode_base64_image(image_payload)
    width, height = image.size
    model = get_model()

    results = model(image, conf=conf_threshold, imgsz=640, verbose=False)
    detections = []
    for result in results:
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            continue

        names = getattr(result, "names", {})
        for box in boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = float(box.conf[0].item())
            class_id = int(box.cls[0].item())
            class_name = names.get(class_id, str(class_id))

            detections.append(
                {
                    "class_id": class_id,
                    "class_name": class_name,
                    "confidence": round(conf, 4),
                    "box": {
                        "x": round(float(x1), 2),
                        "y": round(float(y1), 2),
                        "width": round(float(x2 - x1), 2),
                        "height": round(float(y2 - y1), 2),
                    },
                }
            )

    return {
        "detections": detections,
        "image": {"width": width, "height": height},
        "count": len(detections),
        "model": {"path": str(MODEL_PATH), "class_names": list(get_model().names.values())},
    }


app = FastAPI(title="Sidewalk Accessibility Inference API")
allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health_check():
    try:
        model = get_model()
    except Exception as exc:
        logger.exception("Inference service health check failed to load the model.")
        raise HTTPException(status_code=503, detail="The trained YOLO model is not ready.") from exc

    return {
        "status": "ok",
        "model": str(MODEL_PATH),
        "class_names": list(model.names.values()),
    }


@app.post("/api/infer")
@app.post("/infer")
async def infer(payload: InferenceRequest):
    try:
        result = predict_from_image(payload.image, conf_threshold=payload.conf_threshold)
        return result
    except (ValueError, binascii.Error, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image payload: {exc}") from exc
    except FileNotFoundError as exc:
        logger.exception("The trained YOLO model is missing.")
        raise HTTPException(status_code=500, detail="The trained YOLO model is missing.") from exc
    except Exception as exc:  # pragma: no cover - safety net for inference failures
        logger.exception("YOLO inference failed.")
        raise HTTPException(status_code=500, detail="Inference failed.") from exc
