import os
import io
import numpy as np
from flask import Flask, request, Response, jsonify

app = Flask(__name__)
_pipeline = None

def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code='a')
    return _pipeline

def synthesize_wav(text, voice='af_bella', speed=1.0):
    import soundfile as sf
    pipe = get_pipeline()
    chunks = [audio for _, _, audio in pipe(text, voice=voice, speed=speed) if audio is not None and len(audio) > 0]
    if not chunks:
        return None
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(chunks), 24000, format='WAV')
    buf.seek(0)
    return buf.read()

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/voices')
def voices():
    return jsonify({'voices': ['af_bella', 'bf_alice', 'bf_emma', 'am_adam']})

@app.route('/synthesize', methods=['POST'])
def synthesize():
    data = request.get_json()
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'No text'}), 400
    voice = data.get('voice') or os.getenv('TTS_VOICE', 'af_bella')
    speed = float(data.get('speed', 1.0))
    wav = synthesize_wav(text, voice, speed)
    if not wav:
        return jsonify({'error': 'Synthesis failed'}), 500
    return Response(wav, mimetype='audio/wav')

if __name__ == '__main__':
    port = int(os.getenv('TTS_PORT', 3002))
    print(f'TTS service on port {port}')
    app.run(host='0.0.0.0', port=port)
