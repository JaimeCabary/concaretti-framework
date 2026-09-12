"""
Offline Wake Word Listener for Concaretti.
Uses PocketSphinx (via SpeechRecognition) to detect "Hey Concaretti" or "Concaretti"
without sending any audio to the cloud. Emits a voice_trigger SSE event to the frontend.
"""

import asyncio
import threading
import time

try:
    import speech_recognition as sr
except ImportError:
    sr = None

from sse import get_broker

class WakeWordListener:
    def __init__(self):
        self.running = False
        self.thread = None
        self.stop_listening = None
        
    def _listen_loop(self):
        if not sr:
            print("[wake-word] SpeechRecognition not installed, disabled.")
            return
            
        recognizer = sr.Recognizer()
        # Optimize for short phrases
        recognizer.pause_threshold = 0.5
        
        try:
            mic = sr.Microphone()
        except OSError:
            print("[wake-word] No default microphone found, disabled.")
            return

        with mic as source:
            # Calibrate ambient noise
            recognizer.adjust_for_ambient_noise(source, duration=1)

        print("[wake-word] Listening for 'Hey Concaretti' offline...")
        
        # We use listen_in_background for non-blocking continuous listening
        def _callback(recognizer, audio):
            try:
                # PocketSphinx is fully offline. It may not be perfect, 
                # so we check for approximate phonetic matches.
                text = recognizer.recognize_sphinx(audio).lower()
                
                # Check for triggers (Sphinx might mishear concaretti)
                triggers = ["concaretti", "conca", "hey concaretti", "council"]
                if any(t in text for t in triggers):
                    print(f"[wake-word] Trigger detected! (Heard: '{text}')")
                    
                    broker = get_broker()
                    if broker:
                        # Emitting a global event requires knowing the active session ID.
                        # For a single-user system, we can broadcast to all active sessions.
                        sessions = list(broker._subscribers.keys())
                        for session_id in sessions:
                            broker.voice_trigger(session_id, "Hey Concaretti")
                            
            except sr.UnknownValueError:
                pass
            except sr.RequestError as e:
                print(f"[wake-word] Sphinx error: {e}")
            except Exception as e:
                pass

        # Starts listening in a background thread provided by SpeechRecognition
        self.stop_listening = recognizer.listen_in_background(mic, _callback)

    def start(self):
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._listen_loop, daemon=True)
        self.thread.start()

    def stop(self):
        if self.running:
            self.running = False
            if self.stop_listening:
                self.stop_listening(wait_for_stop=False)

# Global instance
_listener = None

def start_wake_word_listener():
    global _listener
    if _listener is None:
        _listener = WakeWordListener()
        _listener.start()
