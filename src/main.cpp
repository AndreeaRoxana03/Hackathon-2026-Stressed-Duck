#include <M5Unified.h>
#include "DuckAnimation.h"
#include "generated/duck_happy_frames.h"
#include "generated/duck_stressed_frames.h"
#include "generated/duck_smart_frames.h"

enum DuckState {
    DUCK_HAPPY,
    DUCK_STRESSED,
    DUCK_COOL
};

DuckState currentState = DUCK_HAPPY;
DuckAnimation duckAnim;

constexpr uint16_t HAPPY_BACKGROUND = 0xD622;
constexpr uint16_t STRESSED_BACKGROUND = 0xBB6E;
constexpr uint16_t SMART_BACKGROUND = 0x7452;

constexpr int16_t DUCK_ANIM_X = (320 - duck_happy_frame_width) / 2;
constexpr int16_t DUCK_ANIM_Y = 70;
constexpr int16_t DUCK_ANIM_W = duck_happy_frame_width;
constexpr int16_t DUCK_ANIM_H = duck_happy_frame_height;

// Table-punch detection: accel magnitude spike above resting ~1g, with a cooldown to avoid retriggering.
// Punching the table (not the device) transmits an attenuated shock, so this starts lower than a direct-hit
// threshold would be -- watch the Serial Monitor (DEBUG prints below) and raise/lower to match real readings.
constexpr float PUNCH_ACCEL_THRESHOLD_G = 1.25f;
constexpr uint32_t PUNCH_COOLDOWN_MS = 2000;
constexpr uint32_t STRESSED_DURATION_MS = 10000;
// A punch's peak only lasts a sample or two, so track the max seen over a short window instead of
// a single instantaneous reading -- otherwise a brief spike can land between polls and get missed.
constexpr uint32_t PUNCH_WINDOW_MS = 50;
uint32_t lastPunchMs = 0;
uint32_t lastDebugPrintMs = 0;
uint32_t stressedSinceMs = 0;
float windowMaxMagnitude = 0.0f;
uint32_t windowStartMs = 0;

void setDuckState(DuckState state) {
    currentState = state;

    if (state == DUCK_STRESSED) {
        stressedSinceMs = millis();
    }

    auto &lcd = M5.Display;
    lcd.startWrite();
    lcd.fillScreen(TFT_BLACK);

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

    Serial.printf("Duck state set to: %d\n", static_cast<int>(state));
}

void setup() {
    auto cfg = M5.config();
    M5.begin(cfg);

    Serial.begin(115200);

    // Wipe any leftover UI from previous firmware before drawing our own.
    M5.Display.startWrite();
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.endWrite();

    M5.Display.setRotation(1);
    M5.Display.setTextWrap(true);

    duckAnim.begin(DUCK_ANIM_X, DUCK_ANIM_Y, DUCK_ANIM_W, DUCK_ANIM_H);
    setDuckState(DUCK_HAPPY);
}

void checkForPunch() {
    auto mask = M5.Imu.update();
    if (!mask) {
        return;
    }

    auto data = M5.Imu.getImuData();
    float magnitude = sqrtf(data.accel.x * data.accel.x + data.accel.y * data.accel.y + data.accel.z * data.accel.z);

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
            setDuckState(DUCK_STRESSED);
            Serial.println("EVENT:FIST_SLAM");
        }
        windowMaxMagnitude = 0.0f;
        windowStartMs = now;
    }

    if (currentState == DUCK_STRESSED && now - stressedSinceMs >= STRESSED_DURATION_MS) {
        setDuckState(DUCK_COOL);
    }
}

void loop() {
    M5.update();

    if (M5.BtnA.wasPressed()) {
        setDuckState(DUCK_HAPPY);
    } else if (M5.BtnB.wasPressed()) {
        setDuckState(DUCK_STRESSED);
    } else if (M5.BtnC.wasPressed()) {
        setDuckState(DUCK_COOL);
    }

    checkForPunch();
    duckAnim.update();

    delay(10);
}
