// Stops SDL from renaming main to SDL_main, which would need -lSDL2main on Windows.
#define SDL_MAIN_HANDLED
#include <M5Unified.h>
#include "native_compat.h"

#if defined(SDL_h_)

// Emulated GPIO numbers for the mapped keys.
constexpr uint8_t GPIO_BTN_A = 1;
constexpr uint8_t GPIO_BTN_B = 2;
constexpr uint8_t GPIO_BTN_C = 3;
constexpr uint8_t GPIO_PUNCH = 4;

float nativeAccelMagnitude() {
    return m5gfx::gpio_in(GPIO_PUNCH) ? 1.0f : 2.5f;
}

int nativeButtonPressed() {
    static bool prev[3] = {true, true, true};
    const uint8_t pins[3] = {GPIO_BTN_A, GPIO_BTN_B, GPIO_BTN_C};
    int pressed = 0;
    for (int i = 0; i < 3; ++i) {
        bool level = m5gfx::gpio_in(pins[i]);
        if (prev[i] && !level) {
            pressed = i + 1;
        }
        prev[i] = level;
    }
    return pressed;
}

void setup(void);
void loop(void);

static int user_func(bool* running) {
    setup();
    do {
        loop();
    } while (*running);
    return 0;
}

int main(int, char**) {
    lgfx::Panel_sdl::addKeyCodeMapping(SDLK_a, GPIO_BTN_A);
    lgfx::Panel_sdl::addKeyCodeMapping(SDLK_s, GPIO_BTN_B);
    lgfx::Panel_sdl::addKeyCodeMapping(SDLK_d, GPIO_BTN_C);
    lgfx::Panel_sdl::addKeyCodeMapping(SDLK_p, GPIO_PUNCH);
    return lgfx::Panel_sdl::main(user_func);
}

#endif
