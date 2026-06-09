"""macOS Vision OCR sidecar. POST /ocr {"image_path": "/tmp/az_capture.png"} -> {"text": "..."}

Run: uvicorn server:app --port 8124
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()


class OcrRequest(BaseModel):
    image_path: str


def _run_vision_ocr(image_path: str) -> str:
    from Foundation import NSURL
    import Vision

    url = NSURL.fileURLWithPath_(image_path)
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, {})
    request = Vision.VNRecognizeTextRequest.alloc().init()
    # VNRequestTextRecognitionLevelAccurate = 1
    request.setRecognitionLevel_(1)
    request.setUsesLanguageCorrection_(True)

    success, error = handler.performRequests_error_([request], None)
    if not success:
        raise RuntimeError(f"Vision OCR failed: {error}")

    lines = []
    for obs in (request.results() or []):
        candidates = obs.topCandidates_(1)
        if candidates and len(candidates) > 0:
            lines.append(candidates[0].string())

    return "\n".join(lines)


@app.post("/ocr")
def ocr(req: OcrRequest) -> dict:
    try:
        text = _run_vision_ocr(req.image_path)
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
