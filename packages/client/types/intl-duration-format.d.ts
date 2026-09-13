// Intl.DurationFormat (ECMA-402 stage 3) is implemented by every browser we
// target, but TypeScript 5.8's lib.esnext.intl.d.ts does not declare it yet.
// Drop this file when the bundled TS ships the real declarations.
declare namespace Intl {
  type DurationFormatUnit =
    | "years"
    | "months"
    | "weeks"
    | "days"
    | "hours"
    | "minutes"
    | "seconds"
    | "milliseconds"
    | "microseconds"
    | "nanoseconds";

  type DurationFormatUnitDisplay = "always" | "auto";

  type DurationFormatUnitStyle = "long" | "short" | "narrow" | "numeric" | "2-digit";

  interface DurationFormatOptions {
    localeMatcher?: "lookup" | "best fit";
    numberingSystem?: string;
    style?: "long" | "short" | "narrow" | "digital";
    years?: Extract<DurationFormatUnitStyle, "long" | "short" | "narrow">;
    yearsDisplay?: DurationFormatUnitDisplay;
    months?: Extract<DurationFormatUnitStyle, "long" | "short" | "narrow">;
    monthsDisplay?: DurationFormatUnitDisplay;
    weeks?: Extract<DurationFormatUnitStyle, "long" | "short" | "narrow">;
    weeksDisplay?: DurationFormatUnitDisplay;
    days?: Extract<DurationFormatUnitStyle, "long" | "short" | "narrow">;
    daysDisplay?: DurationFormatUnitDisplay;
    hours?: DurationFormatUnitStyle;
    hoursDisplay?: DurationFormatUnitDisplay;
    minutes?: DurationFormatUnitStyle;
    minutesDisplay?: DurationFormatUnitDisplay;
    seconds?: DurationFormatUnitStyle;
    secondsDisplay?: DurationFormatUnitDisplay;
    milliseconds?: Extract<
      DurationFormatUnitStyle,
      "long" | "short" | "narrow" | "numeric"
    >;
    millisecondsDisplay?: DurationFormatUnitDisplay;
    microseconds?: Extract<
      DurationFormatUnitStyle,
      "long" | "short" | "narrow" | "numeric"
    >;
    microsecondsDisplay?: DurationFormatUnitDisplay;
    nanoseconds?: Extract<
      DurationFormatUnitStyle,
      "long" | "short" | "narrow" | "numeric"
    >;
    nanosecondsDisplay?: DurationFormatUnitDisplay;
    fractionalDigits?: number;
  }

  type DurationInput = Partial<Record<DurationFormatUnit, number>>;

  class DurationFormat {
    constructor(
      locales?: string | string[],
      options?: DurationFormatOptions,
    );
    format(duration: DurationInput): string;
    formatToParts(
      duration: DurationInput,
    ): { type: string; value: string; unit?: string }[];
    resolvedOptions(): DurationFormatOptions & { locale: string };
  }
}
