# Voice Input (ASR) Commands

Use voice input for hands-free text entry in Zai.Vim using Automatic Speech Recognition.

## Overview

Zai.Vim integrates with [zasr-server](https://github.com/zighouse/zasr) to provide real-time voice input:
- Speak naturally in multiple languages
- Real-time transcription appears in buffer
- Auto-stop after silence detection
- Toggle on/off with single keystroke

## Prerequisites

1. **zasr-server running** on `ws://localhost:2026`
2. **Microphone** available and working
3. **Python packages installed:**
   ```bash
   pip install websockets pyaudio
   ```
4. **PortAudio installed** (Linux):
   ```bash
   sudo apt install portaudio19-dev python3-pyaudio
   ```

See [Voice Input Setup](../installation/asr.md) for complete installation.

## ASR Commands

### `<C-G>` (in insert mode)

Toggle ASR on/off.

**Usage:**
1. Enter insert mode in any buffer: `i`
2. Press `Ctrl-G`
3. Speak into microphone
4. Text appears in real-time
5. Press `Ctrl-G` again to stop, or wait for auto-stop (3 sec silence)

**Mode:** Insert mode

**Behavior:**
- Starts ASR on first press
- Shows status message: "ASR started"
- Transcribes speech as you speak
- Stops after 3 seconds of silence
- Or press `Ctrl-G` to manually stop

### `:ASRToggle`

Toggle ASR on/off from command mode.

**Usage:**
```vim
:ASRToggle
```

**Mode:** Any mode

**Key Mapping:** None (command only)

### `:ASRStart`

Start voice input.

**Usage:**
```vim
:ASRStart
```

**Mode:** Any mode

**Behavior:**
- Starts ASR if not already running
- Enters insert mode automatically
- Shows status message

### `:ASRStop`

Stop voice input.

**Usage:**
```vim
:ASRStop
```

**Mode:** Any mode

**Behavior:**
- Stops ASR if running
- Finalizes transcription
- Shows status message

## Configuration

### Auto-enable ASR

Enable ASR automatically when plugin loads.

**In .vimrc:**
```vim
let g:zai_auto_enable_asr = 1
```

### ASR Server URL

Custom WebSocket server URL.

**Environment variable:**
```bash
export ZASR_SERVER_URL="ws://localhost:2026"
```

**Default:** `ws://localhost:2026`

## Using ASR

### Basic Workflow

```vim
" 1. Open Zai
:Zai

" 2. Enter insert mode in input window
i

" 3. Start ASR
<C-G>

" 4. Speak naturally
" Text appears in real-time as you speak

" 5. Wait 3 seconds of silence, or press <C-G> to stop

" 6. Review and edit if needed

" 7. Send message
<Esc>
<CR>
```

### Dictation Example

```vim
:Zai
i                          " Enter insert mode
<C-G>                      " Start ASR
" (speak) How do I implement async await in Python?
" (wait 3 seconds for auto-stop)
<Esc>                      " Exit insert mode
<CR>                       " Send message
```

### Supported Languages

SenseVoice (default ASR model) supports:
- **Chinese** (Mandarin)
- **English**
- **Japanese**
- **Korean**
- **Cantonese** (Yue)

Language is detected automatically.

## Status Messages

### Connection Status

```
Zai ASR: Connected to ws://localhost:2026
```

ASR successfully connected to server.

```
Zai ASR: Connection failed - ensure zasr-server is running
```

Cannot connect to WebSocket server.

### Recognition Status

```
Zai ASR: Started
```

ASR is listening for speech.

```
Zai ASR: Stopped
```

ASR stopped (manual or auto-stop).

```
Zai ASR: Listening...
```

Waiting for speech input.

```
Zai ASR: Processing...
```

Transcribing audio to text.

## Troubleshooting

### ASR Not Starting

**Check:**
1. zasr-server is running:
   ```bash
   ps aux | grep zasr-server
   ```

2. WebSocket port is accessible:
   ```bash
   netstat -an | grep 2026
   ```

3. Server URL is correct:
   ```bash
   echo $ZASR_SERVER_URL
   ```

**Solution:**
```bash
# Start zasr-server
cd zasr
RECOGNIZER_TYPE=sense-voice ./start-server.sh
```

### No Text Appears

**Check:**
1. Microphone is working:
   ```bash
   # Linux
   arecord -f cd -d 5 test.wav
   aplay test.wav

   # macOS
   sox -d test.wav
   ```

2. Python audio packages:
   ```bash
   python3 -c "import pyaudio; print('OK')"
   ```

3. Microphone permissions (Linux):
   ```bash
   groups  # Check if in audio group
   sudo usermod -aG audio $USER
   ```

### Poor Recognition Quality

**Solutions:**
1. Speak clearly and at moderate pace
2. Reduce background noise
3. Move closer to microphone
4. Check microphone quality
5. Ensure ASR model matches language

### ASR Stops Immediately

**Check:**
1. Microphone is not muted
2. Audio input level is sufficient
3. No audio conflicts (other apps using mic)

## Advanced Usage

### ASR in Code Comments

```vim
" Document code with voice
i
<C-G>
" (speak) This function parses JSON data from the API response
<Esc>
```

### ASR for Documentation

```vim
" Write documentation
:ZaiNew
:prompt You are a technical writer.
i
<C-G>
" (speak) Create documentation for the REST API endpoints
<Esc>
<CR>
```

### Multilingual Dictation

SenseVoice auto-detects language:

```vim
" Speak Chinese
<C-G>
" (speak in Chinese) 你好，请帮我写一个Python函数
" (wait for auto-stop)

" Switch to English immediately
<C-G>
" (speak in English) Now explain how async works in Python
" (wait for auto-stop)
```

## ASR Server Management

### Start zasr-server

```bash
# With startup script
cd zasr
RECOGNIZER_TYPE=sense-voice ./start-server.sh

# Or manually
./build/zasr-server \
  --recognizer-type sense-voice \
  --silero-vad-model ~/.cache/sherpa-onnx/silero_vad.int8.onnx \
  --sense-voice-model ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx \
  --tokens ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt \
  --port 2026
```

### Run as Service (systemd)

```bash
sudo systemctl start zasr-server
sudo systemctl enable zasr-server  # Start on boot
sudo systemctl status zasr-server  # Check status
```

### Monitor Server

```bash
# Check logs
journalctl -u zasr-server -f

# Check connections
netstat -an | grep 2026

# Test WebSocket
wscat -c ws://localhost:2026
```

## Performance Tips

### Reduce Latency

1. Use local zasr-server (not network)
2. Close other audio applications
3. Use quality microphone
4. Reduce background noise

### Improve Accuracy

1. Speak clearly and at natural pace
2. Minimize background noise
3. Use appropriate microphone distance
4. Ensure quiet environment

## Best Practices

1. **Test First:** Test ASR with simple phrases before long dictation
2. **Review Text:** ASR isn't perfect, review and edit transcribed text
3. **Short Segments:** Speak in shorter segments for better accuracy
4. **Punctuation:** ASR adds basic punctuation, edit as needed
5. **Command Words:** Spell technical terms if needed

## Limitations

- Requires internet connection for some ASR models
- Accuracy varies by speaking style
- Background noise affects recognition
- Punctuation may need editing
- Technical terms may need spelling

## Next Steps

- [Voice Input Setup](../installation/asr.md) - Complete ASR installation
- [Basic Commands](basic.md) - Zai interface commands
- [Input Commands](input.md) - Send messages and add content
- [Configuration Guide](../configuration/basic.md) - ASR configuration

## Related Topics

- [Installation Guide](../installation/) - Complete setup
- [Session Commands](../configuration/session-commands.md) - Runtime commands
- [Key Mappings](key-mappings.md) - All keyboard shortcuts
