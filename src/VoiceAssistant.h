#pragma once

#include <M5Unified.h>

#ifdef NATIVE_BUILD

// The desktop preview has no speaker data, so voice is a no-op there.
class VoiceAssistant {
public:
    using StatusCallback = void (*)(const char* text);
    void begin(StatusCallback) {}
    void update(bool = false) {}
    void sayStressed() {}
    void sayHappy() {}
    void setIdleChatter(bool) {}
    void setMuted(bool muted) { _muted = muted; }
    bool isMuted() const { return _muted; }
    bool isSpeaking() const { return false; }
    bool isRecording() const { return false; }

private:
    bool _muted = false;
};

#else

// Touching the screen plays a random clip of src/speech.txt, pre-rendered with a neural voice by
// tools/speech_to_clips.py and embedded in the firmware.
class VoiceAssistant {
public:
    using StatusCallback = void (*)(const char* text);
    void begin(StatusCallback onStatus);
    // touchConsumed: this frame's touch already hit a button, so it must not trigger a [touch] line.
    void update(bool touchConsumed = false);
    // Speaks a random line from the [stressed] section of speech.txt, interrupting any current clip.
    void sayStressed();
    // Speaks a random line from the [happy] section without needing a touch.
    void sayHappy();
    // Enabled only in the happy state: speaks a random [happy] line every 20-60 s and a [touch] line on each
    // screen touch. While disabled, touches are ignored.
    void setIdleChatter(bool enabled);
    // While muted nothing is spoken and any clip in progress is cut off.
    void setMuted(bool muted);
    bool isMuted() const { return _muted; }
    bool isSpeaking() const { return _speaking; }
    bool isRecording() const { return false; }

private:
    void speakClip(uint32_t group, size_t index);
    void speakRandom(uint32_t group, size_t& lastIndex);
    void scheduleChatter();
    void setStatus(const char* text);

    StatusCallback _onStatus = nullptr;
    const char* _status = nullptr;
    int16_t* _pcm[2] = {nullptr, nullptr};
    uint8_t _activeBuffer = 0;
    size_t _lastTouch = static_cast<size_t>(-1);
    size_t _lastStressed = static_cast<size_t>(-1);
    size_t _lastHappy = static_cast<size_t>(-1);
    bool _chatter = false;
    bool _muted = false;
    uint32_t _nextChatterMs = 0;
    bool _speaking = false;
};

#endif
