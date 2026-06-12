"""Contract test for /tts_stream. Requires the sidecar running on :8123:
    /opt/homebrew/bin/uvicorn server:app --port 8123
Run:  /opt/homebrew/bin/python3.12 test_stream.py
"""
import time
import requests

TEXT = ("The ability to communicate clearly in English is one of the most "
        "valuable skills you can develop. Keep practicing every day.")


def main():
    t0 = time.time()
    r = requests.post("http://127.0.0.1:8123/tts_stream", json={"text": TEXT}, stream=True)
    assert r.status_code == 200, f"status {r.status_code}"
    ctype = r.headers.get("content-type", "")
    assert "L16" in ctype or "octet" in ctype, f"unexpected content-type {ctype!r}"

    first = None
    chunks = 0
    total = 0
    for chunk in r.iter_content(chunk_size=8192):
        if not chunk:
            continue
        if first is None:
            first = time.time() - t0
        chunks += 1
        total += len(chunk)

    assert first is not None and first < 1.0, f"first chunk too slow: {first}"
    assert chunks >= 2, f"expected multiple chunks, got {chunks}"
    assert total > 0, "no audio"
    assert total % 2 == 0, f"odd byte count {total} (not int16-framed)"
    print(f"OK: first chunk {first:.2f}s, {chunks} chunks, {total} bytes ({total/2/24000:.1f}s audio)")


if __name__ == "__main__":
    main()
