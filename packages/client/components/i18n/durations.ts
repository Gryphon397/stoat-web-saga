import { createSignal } from "solid-js";

import { Language } from "./Languages";

const [durationLocale, setDurationLocale] = createSignal<string>(
  Language.ENGLISH,
);

/**
 * Format a duration (e.g. a slowmode cooldown) in the active locale
 */
export function useDurationFormat() {
  return (
    duration: Partial<Record<Intl.DurationFormatUnit, number>>,
    options: Intl.DurationFormatOptions = { style: "long" },
    // eslint-disable-next-line solid/reactivity
  ) => new Intl.DurationFormat(durationLocale(), options).format(duration);
}

export function updateDurationLocale(key: Language) {
  // Not every Language is a real BCP-47 tag — the joke locales ("enchantment",
  // "piglatin", …) would make the Intl constructor throw, so fall back to
  // English for anything Intl does not recognise.
  try {
    Intl.getCanonicalLocales(key);
    setDurationLocale(key);
  } catch {
    setDurationLocale(Language.ENGLISH);
  }
}
