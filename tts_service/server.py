"""Persistent Qwen3-TTS server (MLX-Audio). POST /tts {"text": "..."} -> audio/wav.

Verified working: mlx_audio + Qwen3-TTS VoiceDesign-8bit on Apple Silicon,
~2x realtime, ~6GB peak RAM. Run: uvicorn server:app --port 8123
"""
import glob
import os
import tempfile
import numpy as np
from fastapi import FastAPI
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from mlx_audio.tts.utils import load_model
from mlx_audio.tts.generate import generate_audio

MODEL_PATH = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"
INSTRUCT = "a clear natural male voice, calm, mid-range pitch, like a friendly colleague"
STREAMING_INTERVAL = 0.5  # seconds of audio per streamed chunk

app = FastAPI()
model = load_model(MODEL_PATH)   # loaded once at startup (heavy)


class Req(BaseModel):
    text: str


@app.post("/tts")
async def tts(req: Req):
    # generate_audio uses MLX; MLX requires generation on the main thread
    # (the same thread where the Metal/GPU context was created).
    # Making the endpoint async avoids FastAPI's threadpool dispatch so that
    # the function body runs directly on the uvicorn event-loop thread (main).
    with tempfile.TemporaryDirectory() as d:
        generate_audio(
            text=req.text,
            model=model,
            instruct=INSTRUCT,
            stt_model=None,
            output_path=d,
            file_prefix="o",
            audio_format="wav",
            save=True,
            verbose=False,
        )
        wav = sorted(glob.glob(os.path.join(d, "o*.wav")))[0]
        with open(wav, "rb") as f:
            data = f.read()
    return Response(content=data, media_type="audio/wav")


@app.post("/tts_stream")
async def tts_stream(req: Req):
    # Stream int16 LE mono PCM at 24kHz as mlx_audio generates it. The model
    # generator is synchronous and MUST run on this (event-loop / Metal) thread,
    # so we iterate it inline; each yield flushes a chunk to the client.
    def pcm_chunks():
        for r in model.generate(
            text=req.text,
            instruct=INSTRUCT,
            stream=True,
            streaming_interval=STREAMING_INTERVAL,
            verbose=False,
        ):
            audio = np.array(r.audio, dtype=np.float32)
            pcm = np.clip(audio, -1.0, 1.0)
            pcm = (pcm * 32767.0).astype("<i2").tobytes()
            yield pcm

    async def agen():
        for chunk in pcm_chunks():
            yield chunk

    return StreamingResponse(agen(), media_type="audio/L16; rate=24000; channels=1")
