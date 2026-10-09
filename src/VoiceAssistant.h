#pragma once

#include <M5Unified.h>

#ifdef NATIVE_BUILD

// The desktop preview has no speaker data, so voice is a no-op there.
class VoiceAssistant {
public:
    using StatusCallback = void (*)(const char* text);
    void begin(StatusCallback) {}
    void update() {}
    void sayStressed() {}
    void sayHappy() {}
    void quack() {}
    bool beginHostAudio(size_t) { return false; }
    int appendHostAudio(const char*) { return -1; }
    bool finishHostAudio() { return false; }
    void cancelHostAudio() {}
    void setIdleChatter(bool) {}
    bool isSpeaking() const { return false; }
    bool isRecording() const { return false; }
};

#else

// Touching the screen plays a random clip of src/speech.txt, pre-rendered with a neural voice by
// tools/speech_to_clips.py and embedded in the firmware.
class VoiceAssistant {
public:
    using StatusCallback = void (*)(const char* text);
    void begin(StatusCallback onStatus);
    void update();
    // Speaks a random line from the [stressed] section of speech.txt, interrupting any current clip.
    void sayStressed();
    // Speaks a random line from the [happy] section without needing a touch.
    void sayHappy();
    void quack();
    bool beginHostAudio(size_t bytes);
    int appendHostAudio(const char* hex);
    bool finishHostAudio();
    void cancelHostAudio();
    // While enabled, speaks a random [happy] line every 20-60 s when nothing else is being said.
    void setIdleChatter(bool enabled);
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
    uint32_t _nextChatterMs = 0;
    bool _speaking = false;
    bool _hostAudioReceiving = false;
    bool _hostAudioPlaying = false;
    size_t _hostAudioBytes = 0;
    size_t _hostAudioReceived = 0;
};

#endif
