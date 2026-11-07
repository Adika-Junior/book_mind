# Piper voices

Voice models for read-aloud live here (they're large, so they're not committed):

    python tools/voices.py list
    python tools/voices.py get en_GB-cori-high

Each voice is `<id>.onnx` + `<id>.onnx.json`, with a `<id>.card.json` recording its source,
licence and — for custom voices — the speaker's consent. See ../../docs/VOICES.md.
