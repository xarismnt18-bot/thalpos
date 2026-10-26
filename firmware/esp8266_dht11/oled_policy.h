#pragma once

// End is exclusive. Equal start/end disables the quiet-hours interval.
constexpr bool oledQuietHour(int hour, int start, int end) {
  return start == end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

static_assert(oledQuietHour(23, 23, 8), "Quiet hours include the start");
static_assert(oledQuietHour(0, 23, 8), "Quiet hours cross midnight");
static_assert(oledQuietHour(7, 23, 8), "Quiet hours include early morning");
static_assert(!oledQuietHour(8, 23, 8), "OLED wakes at the end hour");
static_assert(!oledQuietHour(22, 23, 8), "OLED stays on before night");
static_assert(oledQuietHour(14, 13, 16), "Daytime quiet windows also work");
static_assert(!oledQuietHour(16, 13, 16), "Daytime end is exclusive");
static_assert(!oledQuietHour(0, 8, 8), "Equal endpoints disable quiet hours");
