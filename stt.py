import os
from flask import Flask, request, jsonify

app = Flask(__name__)
_model = None

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(
            os.getenv('WHISPER_MODEL', 'base'),
            device=os.getenv('WHISPER_DEVICE', 'cpu'),
            compute_type='int8',
        )
    return _model

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/transcribe', methods=['POST'])
def transcribe():
    data = request.get_json()
    audio_path = data.get('audio_path', '')
    if not audio_path or not os.path.exists(audio_path):
        return jsonify({'error': 'Audio file not found'}), 400
    segments, info = get_model().transcribe(audio_path, vad_filter=True)
    text = ' '.join(s.text for s in segments).strip()
    return jsonify({'text': text, 'language': info.language})

if __name__ == '__main__':
    port = int(os.getenv('STT_PORT', 3001))
    print(f'STT service on port {port}')
    app.run(host='0.0.0.0', port=port)
