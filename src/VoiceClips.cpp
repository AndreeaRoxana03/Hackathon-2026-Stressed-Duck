#ifndef NATIVE_BUILD

#include "VoiceAssistant.h"
#include <cmath>

// Rendered from src/speech.txt by tools/speech_to_clips.py and embedded via board_build.embed_files.
extern const uint8_t clipsStart[] asm("_binary_src_generated_speech_clips_bin_start");
extern const uint8_t clipsEnd[] asm("_binary_src_generated_speech_clips_bin_end");

namespace {
constexpr size_t PCM_CAPACITY = 22050 * 12;  // samples
constexpr uint8_t SPEAKER_VOLUME = 220;

const char* const IDLE_STATUS = "Touch to hear the duck";

uint32_t readU32(const uint8_t* p) {
    uint32_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

// Blob layout: uint32 sample rate, uint32 group count, then per group uint32 clip count followed by
// clips of uint32 sample count + int16 samples. Group 0 plays on touch, group 1 when the duck gets stressed.
constexpr uint32_t GROUP_TOUCH = 0;
constexpr uint32_t GROUP_STRESSED = 1;
constexpr uint32_t GROUP_HAPPY = 2;
constexpr uint32_t CHATTER_MIN_MS = 20000;
constexpr uint32_t CHATTER_SPAN_MS = 40000;

// Locates a group's first clip; false if the blob is too short or the group is missing.
bool findGroup(uint32_t group, const uint8_t*& first, uint32_t& clips, uint32_t& rate) {
    if (clipsEnd - clipsStart < 12) {
        return false;
    }
    rate = readU32(clipsStart);
    const uint32_t groups = readU32(clipsStart + 4);
    const uint8_t* p = clipsStart + 8;
    for (uint32_t g = 0; g < groups; ++g) {
        if (p + 4 > clipsEnd) {
            return false;
        }
        const uint32_t n = readU32(p);
        p += 4;
        if (g == group) {
            first = p;
            clips = n;
            return true;
        }
        for (uint32_t i = 0; i < n; ++i) {
            if (p + 4 > clipsEnd) {
                return false;
            }
            p += 4 + readU32(p) * 2;
        }
    }
    return false;
}

// Picks clip number `index` (wrapping) within a group; false if the group is empty or truncated.
bool findClip(uint32_t group, size_t index, const uint8_t*& samples, size_t& count, uint32_t& rate) {
    const uint8_t* p = nullptr;
    uint32_t clips = 0;
    if (!findGroup(group, p, clips, rate) || clips == 0) {
        return false;
    }
    for (size_t i = 0; i < index % clips; ++i) {
        p += 4 + readU32(p) * 2;
    }
    count = readU32(p);
    if (p + 4 + count * 2 > clipsEnd) {
        return false;
    }
    samples = p + 4;
    return true;
}

uint32_t clipCount(uint32_t group) {
    const uint8_t* p = nullptr;
    uint32_t clips = 0;
    uint32_t rate = 0;
    return findGroup(group, p, clips, rate) ? clips : 0;
}
}  // namespace

void VoiceAssistant::begin(StatusCallback onStatus) {
    _onStatus = onStatus;

    for (auto& buffer : _pcm) {
        buffer = static_cast<int16_t*>(ps_malloc(PCM_CAPACITY * sizeof(int16_t)));
        if (!buffer) {
            setStatus("Voice: no PSRAM");
            return;
        }
    }

    M5.Speaker.end();
    auto speakerConfig = M5.Speaker.config();
    speakerConfig.stereo = true;
    M5.Speaker.config(speakerConfig);
    const bool speakerStarted = M5.Speaker.begin();
    M5.Speaker.setVolume(SPEAKER_VOLUME);
    Serial.printf("Voice: speaker started=%d enabled=%d stereo=%d bck=%d ws=%d data=%d volume=%u\n",
                  speakerStarted, M5.Speaker.isEnabled(), speakerConfig.stereo, speakerConfig.pin_bck,
                  speakerConfig.pin_ws, speakerConfig.pin_data_out, M5.Speaker.getVolume());
    setStatus(IDLE_STATUS);
}

void VoiceAssistant::update() {
    if (!_pcm[0] || !_pcm[1]) {
        return;
    }

    if (_speaking) {
        if (!M5.Speaker.isPlaying()) {
            _speaking = false;
            if (_hostAudioPlaying) {
                _hostAudioPlaying = false;
                Serial.println("ACK|AUDIO=DONE");
            }
            Serial.println("Voice: clip finished");
            setStatus(IDLE_STATUS);
        }
        return;
    }

    if (_hostAudioReceiving) {
        return;
    }

    if (_chatter && millis() >= _nextChatterMs) {
        scheduleChatter();
        speakRandom(GROUP_HAPPY, _lastHappy);
        return;
    }

    if (M5.Touch.getDetail(0).wasPressed()) {
        scheduleChatter();
        speakRandom(GROUP_TOUCH, _lastTouch);
    }
}

void VoiceAssistant::sayStressed() {
    speakRandom(GROUP_STRESSED, _lastStressed);
}

void VoiceAssistant::sayHappy() {
    speakRandom(GROUP_HAPPY, _lastHappy);
}

void VoiceAssistant::quack() {
    if (!_pcm[0] || !_pcm[1]) {
        return;
    }
    _activeBuffer ^= 1;
    int16_t* pcm = _pcm[_activeBuffer];
    constexpr uint32_t rate = 16000;
    constexpr size_t count = rate / 3;
    for (size_t index = 0; index < count; ++index) {
        const float time = static_cast<float>(index) / rate;
        const float envelope = sinf(3.14159265f * index / count);
        const float phase = 6.2831853f * (650.0f * time - 500.0f * time * time);
        pcm[index] = static_cast<int16_t>(10000.0f * envelope * (sinf(phase) + 0.4f * sinf(3.0f * phase)));
    }
    _speaking = M5.Speaker.playRaw(pcm, count, rate, false, 1, -1, true);
    Serial.printf("Voice: quack started=%d\n", _speaking);
}

void VoiceAssistant::setIdleChatter(bool enabled) {
    _chatter = enabled;
    if (enabled) {
        scheduleChatter();
    }
}

bool VoiceAssistant::beginHostAudio(size_t bytes) {
    if (!_pcm[0] || !_pcm[1] || bytes == 0 || bytes % 2 != 0 || bytes > PCM_CAPACITY * sizeof(int16_t)) {
        return false;
    }
    cancelHostAudio();
    _activeBuffer ^= 1;
    _hostAudioBytes = bytes;
    _hostAudioReceived = 0;
    _hostAudioReceiving = true;
    return true;
}

int VoiceAssistant::appendHostAudio(const char* hex) {
    const size_t length = strlen(hex);
    if (!_hostAudioReceiving || length == 0 || length > 512 || length % 2 != 0 ||
        _hostAudioReceived + length / 2 > _hostAudioBytes) {
        return -1;
    }
    auto digit = [](char character) -> int {
        if (character >= '0' && character <= '9') { return character - '0'; }
        if (character >= 'a' && character <= 'f') { return character - 'a' + 10; }
        return -1;
    };
    for (size_t index = 0; index < length; ++index) {
        if (digit(hex[index]) < 0) { return -1; }
    }
    uint8_t* destination = reinterpret_cast<uint8_t*>(_pcm[_activeBuffer]);
    for (size_t index = 0; index < length; index += 2) {
        destination[_hostAudioReceived++] = static_cast<uint8_t>((digit(hex[index]) << 4) | digit(hex[index + 1]));
    }
    return static_cast<int>(_hostAudioReceived);
}

bool VoiceAssistant::finishHostAudio() {
    if (!_hostAudioReceiving || _hostAudioReceived != _hostAudioBytes) {
        return false;
    }
    _hostAudioReceiving = false;
    _hostAudioPlaying = M5.Speaker.playRaw(_pcm[_activeBuffer], _hostAudioBytes / 2, 16000, false, 1, -1, true);
    _speaking = _hostAudioPlaying;
    Serial.printf("Voice: host speech started=%d bytes=%u\n", _hostAudioPlaying, static_cast<unsigned>(_hostAudioBytes));
    return _hostAudioPlaying;
}

void VoiceAssistant::cancelHostAudio() {
    if (_hostAudioReceiving || _hostAudioPlaying || _speaking) {
        M5.Speaker.stop();
    }
    _hostAudioReceiving = false;
    _hostAudioPlaying = false;
    _speaking = false;
    _hostAudioBytes = 0;
    _hostAudioReceived = 0;
}

void VoiceAssistant::scheduleChatter() {
    _nextChatterMs = millis() + CHATTER_MIN_MS + esp_random() % CHATTER_SPAN_MS;
}

void VoiceAssistant::speakRandom(uint32_t group, size_t& lastIndex) {
    const uint32_t clips = clipCount(group);
    if (clips == 0) {
        return;
    }
    size_t pick = esp_random() % clips;
    if (clips > 1 && pick == lastIndex) {
        pick = (pick + 1) % clips;
    }
    lastIndex = pick;
    speakClip(group, pick);
}

void VoiceAssistant::speakClip(uint32_t group, size_t index) {
    if (!_pcm[0] || !_pcm[1]) {
        return;
    }
    const uint8_t* samples = nullptr;
    size_t count = 0;
    uint32_t rate = 0;
    if (!findClip(group, index, samples, count, rate)) {
        setStatus("No speech clips");
        return;
    }

    // Alternate buffers so a new clip can interrupt one that is still being read by the speaker task.
    // Flash data may be unaligned for int16 access, so copy to PSRAM before playing.
    _activeBuffer ^= 1;
    int16_t* pcm = _pcm[_activeBuffer];
    if (count > PCM_CAPACITY) {
        count = PCM_CAPACITY;
    }
    memcpy(pcm, samples, count * sizeof(int16_t));

    Serial.printf("Voice: group %u clip %u, %u samples at %u Hz, free heap %u, free PSRAM %u\n", static_cast<unsigned>(group),
                  static_cast<unsigned>(index), static_cast<unsigned>(count), static_cast<unsigned>(rate),
                  static_cast<unsigned>(ESP.getFreeHeap()), static_cast<unsigned>(ESP.getFreePsram()));

    setStatus("Speaking...");
    M5.Speaker.playRaw(pcm, count, rate, false, 1, -1, true);
    _speaking = true;
}

void VoiceAssistant::setStatus(const char* text) {
    if (_status && strcmp(_status, text) == 0) {
        return;
    }
    _status = text;
    if (_onStatus) {
        _onStatus(text);
    }
}

#endif  // !NATIVE_BUILD
