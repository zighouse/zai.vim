#!/usr/bin/env python3
"""
ASR (Automatic Speech Recognition) script for Vim integration
Connects to zasr-server for real-time speech recognition

Communication Protocol with Vim:
- Sends JSON messages to stdout with different types:
  - {"type": "status", "message": "..."} - Status updates
  - {"type": "partial", "text": "..."} - Partial recognition results
  - {"type": "final", "text": "..."} - Final recognition results
  - {"type": "error", "message": "..."} - Error messages

- Receives "STOP\n" on stdin to signal graceful shutdown
"""

import asyncio
import json
import sys
import signal
import threading
import uuid
import os

try:
    import websockets
except ImportError:
    print("Error: websockets library not installed", file=sys.stderr)
    print("Please run: pip install websockets", file=sys.stderr)
    sys.exit(1)

try:
    import pyaudio
except ImportError:
    print("Error: pyaudio library not installed", file=sys.stderr)
    print("Please run: pip install pyaudio", file=sys.stderr)
    sys.exit(1)

# ============================================================================
# Configuration
# ============================================================================

# Audio configuration
SAMPLE_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SIZE = 512
CHUNK_MS = int(CHUNK_SIZE / SAMPLE_RATE * 1000)
SEND_BATCH_MS = 200
SEND_BATCH_SIZE = int(SAMPLE_RATE * SEND_BATCH_MS / 1000)

# Server configuration
DEFAULT_SERVER_URL = "ws://localhost:2026"
SERVER_URL = os.environ.get("ZASR_SERVER_URL", DEFAULT_SERVER_URL)

# ============================================================================
# Audio Recorder
# ============================================================================

class AudioRecorder:
    """Audio recorder using pyaudio"""

    def __init__(self, sample_rate=SAMPLE_RATE, channels=CHANNELS, chunk_size=CHUNK_SIZE):
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.audio = pyaudio.PyAudio()
        self.stream = None
        self.is_recording = False
        self.lock = threading.Lock()

    def start(self):
        """Start recording"""
        with self.lock:
            self.stream = self.audio.open(
                format=FORMAT,
                channels=self.channels,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size
            )
            self.is_recording = True

    def read_chunk(self):
        """Read a chunk of audio data"""
        with self.lock:
            if self.stream and self.is_recording:
                return self.stream.read(self.chunk_size, exception_on_overflow=False)
        return None

    def stop(self):
        """Stop recording"""
        with self.lock:
            self.is_recording = False
            if self.stream:
                self.stream.stop_stream()
                self.stream.close()
                self.stream = None

    def __del__(self):
        """Cleanup resources"""
        self.stop()
        self.audio.terminate()


# ============================================================================
# Vim Communicator
# ============================================================================

class VimCommunicator:
    """Handles communication with Vim via JSON over stdout"""

    def __init__(self):
        self.running = True
        self.lock = threading.Lock()
        self.pending_partial = ""

    def send_status(self, message):
        """Send a status message to Vim"""
        msg = {"type": "status", "message": message}
        print(json.dumps(msg, ensure_ascii=False))
        sys.stdout.flush()

    def send_partial(self, text):
        """Send a partial recognition result to Vim"""
        msg = {"type": "partial", "text": text}
        print(json.dumps(msg, ensure_ascii=False))
        sys.stdout.flush()

    def send_final(self, text):
        """Send a final recognition result to Vim"""
        msg = {"type": "final", "text": text}
        print(json.dumps(msg, ensure_ascii=False))
        sys.stdout.flush()

    def send_error(self, message):
        """Send an error message to Vim"""
        msg = {"type": "error", "message": message}
        print(json.dumps(msg, ensure_ascii=False))
        sys.stdout.flush()

    def stop(self):
        """Signal the ASR loop to stop"""
        with self.lock:
            self.running = False

    def is_running(self):
        """Check if ASR is still running"""
        with self.lock:
            return self.running


def stdin_monitor(communicator):
    """Monitor stdin for STOP signal from Vim"""
    communicator.send_status("stdin_monitor started")
    while communicator.is_running():
        try:
            line = sys.stdin.readline()
            if not line:  # EOF
                communicator.send_status("stdin_monitor: EOF received")
                break
            if line.strip().upper() == "STOP":
                communicator.send_status("Received stop signal")
                communicator.stop()
                break
            else:
                # Log unexpected input (for debugging)
                if line.strip():
                    communicator.send_status(f"stdin_monitor: unexpected input: {repr(line)}")
        except Exception as e:
            communicator.send_status(f"stdin_monitor error: {str(e)}")
            break
    communicator.send_status("stdin_monitor exited")


# ============================================================================
# WebSocket Message Handling
# ============================================================================

async def receive_messages(ws, task_id, communicator):
    """
    Receive and process messages from zasr-server

    Args:
        ws: WebSocket connection
        task_id: Task ID for this session
        communicator: VimCommunicator instance
    """
    current_sentence = None
    timeout_count = 0
    MAX_TIMEOUTS = 15  # 15 seconds max timeout
    transcription_started = False  # Track if we received TranscriptionStarted

    try:
        while communicator.is_running():
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=1.0)
                timeout_count = 0
            except asyncio.TimeoutError:
                timeout_count += 1
                # Only timeout if we've already received Started
                if transcription_started and timeout_count >= MAX_TIMEOUTS:
                    communicator.send_status("No more messages, stopping...")
                    break
                # Log waiting status every 5 seconds
                if timeout_count % 5 == 0:
                    communicator.send_status(f"Waiting for server... ({timeout_count}s)")
                continue

            if isinstance(message, str):
                try:
                    data = json.loads(message)
                    header = data.get("header", {})
                    name = header.get("name", "UNKNOWN")

                    if name == "Started":
                        transcription_started = True  # Mark that we've received the start response
                        session_id = data.get("payload", {}).get("sid", "")
                        communicator.send_status(f"Transcription started: {session_id}")

                    elif name == "SentenceBegin":
                        payload = data.get("payload", {})
                        index = payload.get("idx", 0)
                        time_ms = payload.get("time", 0)
                        current_sentence = {"index": index, "begin_time": time_ms}

                    elif name == "Result":
                        payload = data.get("payload", {})
                        result = payload.get("text", "")

                        # Send partial result to Vim
                        if result:
                            communicator.send_partial(result)

                        if current_sentence:
                            current_sentence["current_result"] = result

                    elif name == "SentenceEnd":
                        payload = data.get("payload", {})
                        result = payload.get("text", "")

                        # Send final result to Vim
                        if result:
                            communicator.send_final(result + " ")

                        current_sentence = None

                    elif name == "Completed":
                        communicator.send_status("Transcription completed")
                        break

                    elif name == "Failed":
                        status_text = header.get("status_text", "Unknown error")
                        communicator.send_error(f"Transcription failed: {status_text}")
                        break

                except json.JSONDecodeError:
                    pass

    except websockets.exceptions.ConnectionClosed:
        communicator.send_error("Connection closed")
    except Exception as e:
        communicator.send_error(f"Error receiving messages: {str(e)}")


async def send_audio_loop(ws, recorder, communicator, silence_threshold=200, max_silence_seconds=3.0):
    """
    Continuously read audio from microphone and send to server

    Args:
        ws: WebSocket connection
        recorder: AudioRecorder instance
        communicator: VimCommunicator instance
        silence_threshold: RMS threshold for silence detection
        max_silence_seconds: Maximum silence duration before auto-stop
    """
    import audioop

    buffer = b''
    silence_count = 0
    max_silence_batches = int(max_silence_seconds * 1000 / SEND_BATCH_MS)
    total_batches = 0  # Track total batches sent
    warmup_batches = 10  # Warmup period: 10 * 200ms = 2 seconds (no silence detection during warmup)

    #communicator.send_status(f"Audio loop started (warmup={warmup_batches * SEND_BATCH_MS / 1000}s)")

    try:
        loop_count = 0
        while communicator.is_running():
            loop_count += 1
            #if loop_count % 100 == 0:
            #    communicator.send_status(f"Audio loop iteration {loop_count}")

            # Read audio chunk from microphone
            chunk = await asyncio.to_thread(recorder.read_chunk)
            if chunk is None:
                #communicator.send_error("No more audio data from microphone")
                break
            #elif loop_count == 1:
            #    communicator.send_status(f"First chunk received, size={len(chunk)} bytes")

            buffer += chunk

            # Send in batches
            if len(buffer) >= SEND_BATCH_SIZE:
                batch_data = buffer[:SEND_BATCH_SIZE]
                buffer = buffer[SEND_BATCH_SIZE:]

                # Detect volume (RMS)
                rms = audioop.rms(batch_data, 2)
                is_silence = rms < silence_threshold

                # Only check for silence after warmup period
                if total_batches >= warmup_batches:
                    if is_silence:
                        silence_count += 1
                    else:
                        silence_count = 0

                    # Auto-stop on sustained silence
                    if silence_count >= max_silence_batches:
                        communicator.send_status(f"Detected {max_silence_seconds}s silence, stopping...")
                        break
                else:
                    # During warmup, just reset silence count
                    silence_count = 0

                # Send audio data
                try:
                    await ws.send(batch_data)
                    total_batches += 1

                    ## Log progress every 50 batches (10 seconds)
                    #if total_batches % 50 == 0:
                    #    warmup_status = "(warmup)" if total_batches < warmup_batches else ""
                    #    communicator.send_status(f"Sent {total_batches} batches, rms={rms}, silence_count={silence_count}{warmup_status}")
                except Exception as e:
                    communicator.send_error(f"Error sending audio: {str(e)}")
                    break

        ## Check why we exited the loop
        #if not communicator.is_running():
        #    communicator.send_status(f"Audio loop exited: communicator stopped (loop_count={loop_count}, total_batches={total_batches})")
        #else:
        #    communicator.send_status(f"Audio loop exited normally (loop_count={loop_count}, total_batches={total_batches})")

    except Exception as e:
        communicator.send_error(f"Audio loop error: {str(e)}")
        import traceback
        communicator.send_error(f"Traceback: {traceback.format_exc()}")


async def run_asr_session(communicator):
    """
    Run the ASR session with zasr-server

    Args:
        communicator: VimCommunicator instance
    """
    task_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    recorder = AudioRecorder()

    try:
        communicator.send_status(f"Connecting to {SERVER_URL}...")

        async with websockets.connect(SERVER_URL, ping_timeout=120) as ws:
            communicator.send_status("Connected to zasr-server")

            # Send Begin request
            start_request = {
                "header": {
                    "name": "Begin",
                    "mid": message_id
                },
                "payload": {
                    "fmt": "pcm",
                    "rate": SAMPLE_RATE,
                    "itn": True,
                    "silence": 300
                }
            }

            await ws.send(json.dumps(start_request, ensure_ascii=False))

            # Wait for Started response
            try:
                response_text = await asyncio.wait_for(ws.recv(), timeout=10)
                response = json.loads(response_text)

                if (response.get("header", {}).get("name") != "Started" or
                    response.get("header", {}).get("status") != 20000000):
                    communicator.send_error("Failed to start transcription")
                    return

            except asyncio.TimeoutError:
                communicator.send_error("Timeout waiting for transcription start")
                return

            # Start recording
            recorder.start()
            communicator.send_status("Recording started, speak now...")

            # Create concurrent tasks
            receive_task = asyncio.create_task(receive_messages(ws, task_id, communicator))
            send_task = asyncio.create_task(send_audio_loop(ws, recorder, communicator))

            # Wait for send task to complete (silence detected or stop requested)
            #communicator.send_status("Waiting for audio task to complete...")
            await send_task
            communicator.send_status(f"Audio task completed (result={send_task.result() if send_task.done() else 'pending'})")

            # Stop recording
            recorder.stop()
            communicator.send_status("Recording stopped")

            # Send End message
            stop_request = {
                "header": {
                    "name": "End",
                    "mid": str(uuid.uuid4())
                },
                "payload": {}
            }

            await ws.send(json.dumps(stop_request, ensure_ascii=False))

            # Wait for final recognition results
            try:
                await asyncio.wait_for(receive_task, timeout=10)
            except asyncio.TimeoutError:
                communicator.send_status("Timeout waiting for final results")

    except ConnectionRefusedError:
        communicator.send_error(f"Cannot connect to {SERVER_URL}. Is zasr-server running?")
    except Exception as e:
        communicator.send_error(f"Error: {str(e)}")
    finally:
        recorder.stop()


def main():
    """Main entry point"""
    communicator = VimCommunicator()

    # Start stdin monitor in background thread
    stdin_thread = threading.Thread(target=stdin_monitor, args=(communicator,))
    stdin_thread.daemon = True
    stdin_thread.start()

    communicator.send_status("ASR script initialized")

    # Run ASR session
    try:
        asyncio.run(run_asr_session(communicator))
    except Exception as e:
        communicator.send_error(f"Fatal error: {str(e)}")

    communicator.send_status("ASR session ended")

    # Wait for stdin thread
    stdin_thread.join(timeout=1.0)


if __name__ == "__main__":
    main()
