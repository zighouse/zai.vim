# Voice Input (ASR) Setup

This page covers setting up Automatic Speech Recognition (ASR) for hands-free voice input in Zai.Vim.

## Overview

Zai.Vim supports real-time voice input using [zasr-server](https://github.com/zighouse/zasr), a WebSocket-based speech recognition server. This allows you to dictate text directly in insert mode.

## Prerequisites

### Hardware
- Microphone (built-in or external)

### Software
- Python 3.6+
- Git
- CMake and build tools
- PortAudio development headers

## Step 1: Install PortAudio

### Linux (Ubuntu/Debian)

```bash
sudo apt install portaudio19-dev python3-pyaudio
```

### macOS

```bash
brew install portaudio
```

### Windows

PortAudio is included with `pyaudio` installation.

## Step 2: Install Python ASR Dependencies

```bash
pip install websockets pyaudio
```

## Step 3: Install zasr-server

### Clone Repository

```bash
git clone https://github.com/zighouse/zasr.git
cd zasr
```

### Download Dependencies

```bash
cd third_party
bash download_deps.sh
cd ..
```

### Build zasr-server

```bash
mkdir -p build && cd build
cmake ..
make -j$(nproc)
```

## Step 4: Download ASR Models

Models are downloaded to `~/.cache/sherpa-onnx/`.

### Visit Sherpa-ONNX Releases

https://github.com/k2-fsa/sherpa-onnx/releases

### Download Required Models

1. **VAD Model** (Voice Activity Detection):
   - File: `silero_vad.int8.onnx`

2. **ASR Model** (SenseVoice - multilingual):
   - Directory: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
   - Files needed:
     - `model.int8.onnx`
     - `tokens.txt`
     - `config.json`

Place files in:
```
~/.cache/sherpa-onnx/
├── silero_vad.int8.onnx
└── sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/
    ├── model.int8.onnx
    ├── tokens.txt
    └── config.json
```

## Step 5: Start zasr-server

### Option A: Using Startup Script (Recommended)

```bash
cd zasr
RECOGNIZER_TYPE=sense-voice ./start-server.sh
```

### Option B: Manual Start

```bash
cd zasr/build
./zasr-server \
  --recognizer-type sense-voice \
  --silero-vad-model ~/.cache/sherpa-onnx/silero_vad.int8.onnx \
  --sense-voice-model ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx \
  --tokens ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt \
  --port 2026
```

### Verify Server is Running

You should see output like:
```
WebSocket server started on port 2026
Waiting for connections...
```

## Step 6: Enable ASR in Zai

### Option A: Auto-enable on Plugin Load (Recommended)

Add to your `.vimrc` or `init.vim`:

```vim
" Auto-enable ASR when plugin loads
let g:zai_auto_enable_asr = 1
```

### Option B: Manual Enable

Add to your `.vimrc` or `init.vim`:

```vim
" Enable ASR functionality
call zai#asr#setup()
```

Or run in Vim:

```vim
:call zai#asr#setup()
```

## Step 7: Configure Environment (Optional)

Set custom WebSocket server URL:

```bash
export ZASR_SERVER_URL=ws://localhost:2026
```

Default is `ws://localhost:2026`.

## Using Voice Input

### Start/Stop ASR

1. Enter insert mode in Vim: `i`
2. Press `<C-G>` (Ctrl+G) to start ASR
3. Speak into your microphone
4. Text appears in real-time as you speak
5. ASR stops automatically after 3 seconds of silence
6. Press `<C-G>` again to manually stop

### ASR Commands

| Command | Description |
|---------|-------------|
| `<C-G>` (in insert mode) | Toggle ASR on/off |
| `:ASRToggle` | Toggle ASR on/off |
| `:ASRStart` | Start voice input |
| `:ASRStop` | Stop voice input |

### How It Works

1. Connects to zasr-server via WebSocket
2. Streams audio from your microphone
3. Server performs real-time speech recognition
4. Partial results appear as you speak (updated in-place)
5. Final result confirmed after silence detection

### Supported Languages

SenseVoice supports:
- Chinese (Mandarin)
- English
- Japanese
- Korean
- Cantonese (Yue)

## Running zasr-server as a Service

### Using systemd (Linux)

Create `/etc/systemd/system/zasr-server.service`:

```ini
[Unit]
Description=Zai ASR Server
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/zasr
Environment="RECOGNIZER_TYPE=sense-voice"
ExecStart=/path/to/zasr/build/zasr-server \
  --recognizer-type sense-voice \
  --silero-vad-model ~/.cache/sherpa-onnx/silero_vad.int8.onnx \
  --sense-voice-model ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx \
  --tokens ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt \
  --port 2026
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable zasr-server
sudo systemctl start zasr-server
```

### Using tmux

```bash
tmux new-session -d -s zasr 'RECOGNIZER_TYPE=sense-voice ./start-server.sh'
```

Attach to session:

```bash
tmux attach-session -t zasr
```

## Troubleshooting

### ASR Not Connecting

1. Verify zasr-server is running:
   ```bash
   ps aux | grep zasr-server
   ```

2. Check WebSocket port:
   ```bash
   netstat -an | grep 2026
   ```

3. Verify server URL in environment:
   ```bash
   echo $ZASR_SERVER_URL
   ```

### No Audio Input

1. Test microphone:
   ```bash
   # Linux
   arecord -f cd -d 5 test.wav

   # macOS
   sox -d test.wav
   ```

2. Check microphone permissions

3. Verify pyaudio installation:
   ```bash
   python3 -c "import pyaudio; print('OK')"
   ```

### Recognition Accuracy Issues

1. Speak clearly and at moderate pace
2. Reduce background noise
3. Ensure microphone is close to sound source
4. Try different model variants if available

### Server Crashes

1. Check system resources (CPU/memory)
2. Reduce model size if needed
3. Check server logs for error messages
4. Ensure all model files are correctly downloaded

### Port Already in Use

Change the port in zasr-server command:

```bash
./zasr-server ... --port 2027
```

And update environment variable:

```bash
export ZASR_SERVER_URL=ws://localhost:2027
```

## Performance Tips

### Reduce Latency

1. Use smaller model (if available)
2. Run on local machine (not network)
3. Close other CPU-intensive applications
4. Use wired network connection if server is remote

### Improve Accuracy

1. Use quality microphone
2. Speak in quiet environment
3. Speak at natural pace
4. Ensure proper microphone positioning

## Advanced Configuration

### Custom VAD Sensitivity

Adjust voice activity detection sensitivity in zasr-server (if supported):

```bash
./zasr-server ... --vad-threshold 0.5
```

### Language Selection

Some models support language specification. Check model documentation for details.

### Multiple Microphones

Select specific microphone:

```bash
# List devices
python3 -c "import pyaudio; p = pyaudio.PyAudio(); [print(i, p.get_device_info_by_index(i)['name']) for i in range(p.get_device_count())]"

# Use specific device (depends on ASR server implementation)
```

## Resources

- [zasr-server GitHub](https://github.com/zighouse/zasr)
- [Sherpa-ONNX Documentation](https://github.com/k2-fsa/sherpa-onnx)
- [SenseVoice Model](https://github.com/FunAudioLLM/SenseVoice)

## Next Steps

- [Configuration Guide](../configuration/) - Configure Zai settings
- [Session Commands](../commands/) - Learn available commands
- [AI Tools](../tools/) - Explore available tools
