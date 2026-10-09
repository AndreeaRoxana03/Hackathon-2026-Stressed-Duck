#include <M5Unified.h>
#include <cstring>
#include "DuckAnimation.h"
#include "VoiceAssistant.h"
#include "generated/duck_happy_frames.h"
#include "generated/duck_stressed_frames.h"
#include "generated/duck_smart_frames.h"
#include "generated/duck_walk_frames.h"
#include "generated/duck_reverse_walk_frames.h"

enum DuckState {
    DUCK_HAPPY,
    DUCK_STRESSED,
    DUCK_WALK,
    DUCK_COOL
};

DuckState currentState = DUCK_HAPPY;
DuckAnimation duckAnim;
VoiceAssistant voice;
const char* voiceStatus = "";

constexpr uint16_t HAPPY_BACKGROUND = 0xD622;
constexpr uint16_t STRESSED_BACKGROUND = 0xBB6E;
constexpr uint16_t SMART_BACKGROUND = 0x7452;

constexpr int16_t DUCK_ANIM_X = (320 - duck_happy_frame_width) / 2;
constexpr int16_t DUCK_ANIM_Y = 70;
constexpr int16_t DUCK_ANIM_W = duck_happy_frame_width;
constexpr int16_t DUCK_ANIM_H = duck_happy_frame_height;
constexpr int16_t SCREEN_WIDTH = 320;
// Walk endpoints sit fully off-screen so the duck slides in and out from behind the display edges.
constexpr int16_t WALK_LEFT_X = -DUCK_ANIM_W;
constexpr int16_t WALK_RIGHT_X = SCREEN_WIDTH;

// Voice status sits between the mood label and the duck sprite.
constexpr int16_t STATUS_Y = 46;
constexpr int16_t STATUS_H = 22;

// Table-punch detection: accel magnitude spike above resting ~1g, with a cooldown to avoid retriggering.
// Punching the table (not the device) transmits an attenuated shock, so this starts lower than a direct-hit
// threshold would be -- watch the Serial Monitor (DEBUG prints below) and raise/lower to match real readings.
constexpr float PUNCH_ACCEL_THRESHOLD_G = 1.16f;
constexpr uint32_t PUNCH_COOLDOWN_MS = 2000;
constexpr uint32_t STRESSED_DURATION_MS = 3000;
constexpr uint32_t WALK_DURATION_MS = 6000;
constexpr uint32_t SMART_DURATION_MS = 3000;
constexpr uint16_t WALK_FRAME_DELAY_MS = 25;  // 40 FPS, walking only
constexpr size_t HOST_LINE_BUFFER_SIZE = 1024;
constexpr size_t HOST_COMMENT_MAX_LENGTH = 160;
constexpr uint32_t HOST_RESPONSE_TIMEOUT_MS = 10000;
// A punch's peak only lasts a sample or two, so track the max seen over a short window instead of
// a single instantaneous reading -- otherwise a brief spike can land between polls and get missed.
constexpr uint32_t PUNCH_WINDOW_MS = 50;
uint32_t lastPunchMs = 0;
uint32_t lastDebugPrintMs = 0;
uint32_t stressedSinceMs = 0;
uint32_t walkingSinceMs = 0;
uint32_t smartSinceMs = 0;
bool walkReturning = false;
float windowMaxMagnitude = 0.0f;
uint32_t windowStartMs = 0;
char hostLine[HOST_LINE_BUFFER_SIZE + 1] = {};
size_t hostLineLength = 0;
bool hostLineOverflow = false;
char hostComment[HOST_COMMENT_MAX_LENGTH + 1] = {};
bool backendControlled = false;
uint32_t lastHostResponseMs = 0;
DuckState hostMood = DUCK_HAPPY;

const char* wireMood(DuckState state) {
    switch (state) {
        case DUCK_STRESSED:
            return "STRESSED";
        case DUCK_COOL:
            return "COOL";
        case DUCK_HAPPY:
        case DUCK_WALK:
        default:
            return "HAPPY";
    }
}

bool parseHostResponse(const char* line, DuckState& state, char* comment) {
    const char* prefix = nullptr;
    const char* happyPrefix = "RESP|MOOD=HAPPY|COMMENT=";
    const char* stressedPrefix = "RESP|MOOD=STRESSED|COMMENT=";
    const char* coolPrefix = "RESP|MOOD=COOL|COMMENT=";
    if (strncmp(line, happyPrefix, strlen(happyPrefix)) == 0) {
        state = DUCK_HAPPY;
        prefix = happyPrefix;
    } else if (strncmp(line, stressedPrefix, strlen(stressedPrefix)) == 0) {
        state = DUCK_STRESSED;
        prefix = stressedPrefix;
    } else if (strncmp(line, coolPrefix, strlen(coolPrefix)) == 0) {
        state = DUCK_COOL;
        prefix = coolPrefix;
    } else {
        return false;
    }

    const char* suffix = "|FIX=|EXPLAIN=";
    const size_t lineLength = strlen(line);
    const size_t prefixLength = strlen(prefix);
    const size_t suffixLength = strlen(suffix);
    if (lineLength < prefixLength + suffixLength ||
        strcmp(line + lineLength - suffixLength, suffix) != 0) {
        return false;
    }

    const size_t commentLength = lineLength - prefixLength - suffixLength;
    if (commentLength > HOST_COMMENT_MAX_LENGTH) {
        return false;
    }
    for (size_t index = 0; index < commentLength; ++index) {
        const unsigned char value = static_cast<unsigned char>(line[prefixLength + index]);
        if (value < 0x20 || value > 0x7E || value == '|') {
            return false;
        }
    }

    memcpy(comment, line + prefixLength, commentLength);
    comment[commentLength] = '\0';
    return true;
}

void drawVoiceStatus() {
    if (currentState == DUCK_WALK || backendControlled) {
        return;
    }

    uint16_t background = SMART_BACKGROUND;
    uint16_t foreground = TFT_WHITE;
    if (currentState == DUCK_HAPPY) {
        background = HAPPY_BACKGROUND;
        foreground = TFT_BLACK;
    } else if (currentState == DUCK_STRESSED || currentState == DUCK_WALK) {
        background = STRESSED_BACKGROUND;
    }

    auto &lcd = M5.Display;
    lcd.fillRect(0, STATUS_Y, 320, STATUS_H, background);
    lcd.setTextColor(foreground, background);
    lcd.setTextSize(2);
    lcd.setCursor(20, STATUS_Y + 3);
    lcd.print(voiceStatus);
}

void onVoiceStatus(const char* text) {
    voiceStatus = text;
    drawVoiceStatus();
}

void setDuckState(DuckState state) {
    currentState = state;
    if (backendControlled && state == DUCK_HAPPY) {
        voice.cancelHostAudio();
    }

    if (state == DUCK_STRESSED) {
        stressedSinceMs = millis();
    } else if (state == DUCK_WALK) {
        walkingSinceMs = millis();
        walkReturning = false;
    } else if (state == DUCK_COOL) {
        smartSinceMs = millis();
    }

    auto &lcd = M5.Display;
    lcd.startWrite();
    if (state != DUCK_WALK) {
        lcd.fillScreen(TFT_BLACK);
    }

    switch (state) {
        case DUCK_HAPPY:
            lcd.fillScreen(HAPPY_BACKGROUND);
            lcd.setTextColor(TFT_BLACK, HAPPY_BACKGROUND);
            lcd.setTextSize(3);
            lcd.setCursor(20, 20);
            lcd.println("HAPPY DUCK");
            duckAnim.setBackgroundColor(HAPPY_BACKGROUND);
            duckAnim.setFrames(duck_happy_frames, duck_happy_frame_count, 120);
            break;

        case DUCK_STRESSED:
            lcd.fillScreen(STRESSED_BACKGROUND);
            lcd.setTextColor(TFT_WHITE, STRESSED_BACKGROUND);
            lcd.setTextSize(3);
            lcd.setCursor(20, 20);
            lcd.println("STRESSED DUCK");
            duckAnim.setBackgroundColor(STRESSED_BACKGROUND);
            duckAnim.setFrames(duck_stressed_frames, duck_stressed_frame_count, 120);
            break;

        case DUCK_WALK:
            lcd.fillRect(0, 0, SCREEN_WIDTH, STATUS_Y + STATUS_H, STRESSED_BACKGROUND);
            lcd.setTextColor(TFT_WHITE, STRESSED_BACKGROUND);
            lcd.setTextSize(2);
            lcd.setCursor(10, 3);
            lcd.println("DUCK IS THINKING");
            lcd.setCursor(10, 25);
            lcd.println("PLEASE DO NOT DISTURB");
            duckAnim.setBackgroundColor(STRESSED_BACKGROUND);
            duckAnim.setFrames(duck_walk_frames, duck_walk_frame_count, WALK_FRAME_DELAY_MS);
            break;

        case DUCK_COOL:
            lcd.fillScreen(SMART_BACKGROUND);
            lcd.setTextColor(TFT_WHITE, SMART_BACKGROUND);
            lcd.setTextSize(3);
            lcd.setCursor(20, 20);
            lcd.println("SMART DUCK");
            duckAnim.setBackgroundColor(SMART_BACKGROUND);
            duckAnim.setFrames(duck_smart_frames, duck_smart_frame_count, 120);
            break;
    }

    lcd.endWrite();

    duckAnim.snapTo(DUCK_ANIM_X);
    if (state != DUCK_WALK) {
        drawVoiceStatus();
    }

    voice.setIdleChatter(state == DUCK_HAPPY);
    if (state == DUCK_STRESSED && !backendControlled) {
        voice.sayStressed();
    }
    if (state == DUCK_WALK && backendControlled) {
        voice.quack();
    }

    Serial.printf("Duck state set to: %d\n", static_cast<int>(state));
}

void applyHostResponse(const char* line) {
    if (strncmp(line, "AUDIO|BEGIN=", 12) == 0 && backendControlled && currentState == DUCK_COOL) {
        char* end = nullptr;
        const unsigned long bytes = strtoul(line + 12, &end, 10);
        if (end != line + 12 && *end == '\0' && voice.beginHostAudio(bytes)) {
            Serial.println("ACK|AUDIO=0");
        } else {
            Serial.println("ACK|AUDIO=ERROR");
        }
        return;
    }
    if (strncmp(line, "AUDIO|DATA=", 11) == 0 && backendControlled && currentState == DUCK_COOL) {
        const int received = voice.appendHostAudio(line + 11);
        if (received >= 0) {
            Serial.printf("ACK|AUDIO=%d\n", received);
        } else {
            voice.cancelHostAudio();
            Serial.println("ACK|AUDIO=ERROR");
        }
        return;
    }
    if (strcmp(line, "AUDIO|END") == 0) {
        if (!backendControlled || currentState != DUCK_COOL || !voice.finishHostAudio()) {
            Serial.println("ACK|AUDIO=ERROR");
        }
        return;
    }
    if (strcmp(line, "AUDIO|CANCEL") == 0) {
        voice.cancelHostAudio();
        return;
    }
    DuckState requestedState = DUCK_HAPPY;
    char parsedComment[HOST_COMMENT_MAX_LENGTH + 1] = {};
    if (!parseHostResponse(line, requestedState, parsedComment)) {
        return;
    }

    const bool firstHostResponse = !backendControlled;
    backendControlled = true;
    lastHostResponseMs = millis();
    memcpy(hostComment, parsedComment, sizeof(hostComment));
    voiceStatus = "";
    if (firstHostResponse || requestedState != hostMood) {
        setDuckState(requestedState);
    }
    hostMood = requestedState;
    Serial.printf("ACK|MOOD=%s\n", wireMood(requestedState));
}

#ifndef NATIVE_BUILD
void processHostSerial() {
    while (Serial.available() > 0) {
        const int next = Serial.read();
        if (next < 0) {
            return;
        }

        const char character = static_cast<char>(next);
        if (character == '\n') {
            if (!hostLineOverflow) {
                hostLine[hostLineLength] = '\0';
                applyHostResponse(hostLine);
            }
            hostLineLength = 0;
            hostLineOverflow = false;
            continue;
        }
        if (character == '\r') {
            continue;
        }
        if (hostLineLength < HOST_LINE_BUFFER_SIZE) {
            hostLine[hostLineLength++] = character;
        } else {
            hostLineOverflow = true;
        }
    }
}

void checkHostControlTimeout() {
    const uint32_t now = millis();
    if (!backendControlled || now - lastHostResponseMs <= HOST_RESPONSE_TIMEOUT_MS) {
        return;
    }

    backendControlled = false;
    hostMood = DUCK_HAPPY;
    setDuckState(DUCK_HAPPY);
    Serial.println("EVENT:HOST_TIMEOUT");
}
#else
void processHostSerial() {}
void checkHostControlTimeout() {}
#endif

void setup() {
    auto cfg = M5.config();
    M5.begin(cfg);

#ifndef NATIVE_BUILD
    Serial.setRxBufferSize(4096);
#endif
    Serial.begin(115200);

    // Wipe any leftover UI from previous firmware before drawing our own.
    M5.Display.startWrite();
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.endWrite();

    M5.Display.setRotation(1);
    M5.Display.setTextWrap(true);

    duckAnim.begin(DUCK_ANIM_X, DUCK_ANIM_Y, DUCK_ANIM_W, DUCK_ANIM_H);
    setDuckState(DUCK_HAPPY);
    voice.begin(onVoiceStatus);
}

void checkForPunch() {
#ifdef NATIVE_BUILD
    float magnitude = nativeAccelMagnitude();
#else
    auto mask = M5.Imu.update();
    if (!mask) {
        return;
    }

    auto data = M5.Imu.getImuData();
    float magnitude = sqrtf(data.accel.x * data.accel.x + data.accel.y * data.accel.y + data.accel.z * data.accel.z);
#endif

    uint32_t now = millis();

    // TEMP: print every 200ms so the real magnitude range can be observed while tapping the table.
    if (now - lastDebugPrintMs > 200) {
        lastDebugPrintMs = now;
        Serial.printf("accel magnitude: %.2f g\n", magnitude);
    }

    if (magnitude > windowMaxMagnitude) {
        windowMaxMagnitude = magnitude;
    }

    if (now - windowStartMs >= PUNCH_WINDOW_MS) {
        if (windowMaxMagnitude > PUNCH_ACCEL_THRESHOLD_G && (lastPunchMs == 0 || now - lastPunchMs > PUNCH_COOLDOWN_MS)) {
            lastPunchMs = now;
            if (!backendControlled) {
                setDuckState(DUCK_STRESSED);
            }
            Serial.println("EVENT:FIST_SLAM");
        }
        windowMaxMagnitude = 0.0f;
        windowStartMs = now;
    }

    if (!backendControlled) {
        if (currentState == DUCK_STRESSED && now - stressedSinceMs >= STRESSED_DURATION_MS && !voice.isSpeaking()) {
            setDuckState(DUCK_WALK);
        } else if (currentState == DUCK_WALK && now - walkingSinceMs >= WALK_DURATION_MS) {
            setDuckState(DUCK_COOL);
        } else if (currentState == DUCK_COOL && now - smartSinceMs >= SMART_DURATION_MS) {
            setDuckState(DUCK_HAPPY);
        }
    }
}

void updateWalking() {
    if (currentState != DUCK_WALK) {
        return;
    }

    // From the resting spot off the right edge, then right to left off the left edge, at one constant speed.
    constexpr int32_t OUT_DISTANCE = WALK_RIGHT_X - DUCK_ANIM_X;
    constexpr int32_t BACK_DISTANCE = WALK_RIGHT_X - WALK_LEFT_X;
    constexpr int32_t OUT_MS = WALK_DURATION_MS * OUT_DISTANCE / (OUT_DISTANCE + BACK_DISTANCE);
    constexpr int32_t BACK_MS = WALK_DURATION_MS - OUT_MS;
    uint32_t walkingElapsed = millis() - walkingSinceMs;
    if (backendControlled && walkingElapsed >= WALK_DURATION_MS) {
        walkingSinceMs = millis();
        walkReturning = false;
        duckAnim.setFrames(duck_walk_frames, duck_walk_frame_count, WALK_FRAME_DELAY_MS);
        walkingElapsed = 0;
    }
    int32_t elapsed = static_cast<int32_t>(walkingElapsed);

    if (elapsed < OUT_MS) {
        duckAnim.setPosition(DUCK_ANIM_X + OUT_DISTANCE * elapsed / OUT_MS);
        return;
    }

    if (!walkReturning) {
        walkReturning = true;
        duckAnim.setFrames(duck_reverse_walk_frames, duck_reverse_walk_frame_count, WALK_FRAME_DELAY_MS);
    }
    int32_t back = elapsed - OUT_MS;
    if (back > BACK_MS) {
        back = BACK_MS;
    }
    duckAnim.setPosition(WALK_RIGHT_X - BACK_DISTANCE * back / BACK_MS);
}

void loop() {
    M5.update();
    processHostSerial();
    checkHostControlTimeout();
    if (backendControlled && hostMood == DUCK_STRESSED && currentState == DUCK_STRESSED &&
        millis() - stressedSinceMs >= STRESSED_DURATION_MS) {
        setDuckState(DUCK_WALK);
    }

#ifdef NATIVE_BUILD
    int nativeBtn = nativeButtonPressed();
    if (nativeBtn == 1) {
        setDuckState(DUCK_HAPPY);
    } else if (nativeBtn == 2) {
        setDuckState(DUCK_STRESSED);
    } else if (nativeBtn == 3) {
        setDuckState(DUCK_COOL);
    }
#endif

    if (M5.BtnA.wasPressed()) {
        setDuckState(DUCK_HAPPY);
    } else if (M5.BtnB.wasPressed()) {
        setDuckState(DUCK_STRESSED);
    } else if (M5.BtnC.wasPressed()) {
        setDuckState(DUCK_COOL);
    }

    checkForPunch();
    updateWalking();
    voice.update();

    // Image decoding would starve the mic queue, so the duck holds still while recording.
    if (!voice.isRecording()) {
        duckAnim.update();
    }

    delay(10);
}
