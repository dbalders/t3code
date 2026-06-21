declare module "rrule-es" {
  export enum Frequency {
    YEARLY = 0,
    MONTHLY = 1,
    WEEKLY = 2,
    DAILY = 3,
    HOURLY = 4,
    MINUTELY = 5,
    SECONDLY = 6,
  }

  // Keep these aligned with rrule-es@1.0.0 target/types/types.d.ts and runtime output.
  export enum Weekday {
    MO = 1,
    TU = 2,
    WE = 3,
    TH = 4,
    FR = 5,
    SA = 6,
    SU = 7,
  }

  export interface Params {
    readonly tzid: string;
    readonly dtStart: Date;
    readonly freq?: Frequency;
    readonly interval?: number;
    readonly until?: Date | null;
    readonly count?: number;
    readonly wkst?: Weekday | number | null;
    readonly byDay?: ReadonlyArray<Weekday | readonly [number, Weekday]> | null;
    readonly byMonth?: ReadonlyArray<number> | null;
    readonly byMonthDay?: ReadonlyArray<number> | null;
    readonly byWeekNo?: ReadonlyArray<number> | null;
    readonly byHour?: ReadonlyArray<number> | null;
    readonly byMinute?: ReadonlyArray<number> | null;
    readonly bySecond?: ReadonlyArray<number> | null;
    readonly bySetPos?: ReadonlyArray<number> | null;
    readonly exDate?: ReadonlyArray<Date>;
    readonly rDate?: ReadonlyArray<Date>;
  }

  export interface Options {
    readonly strict?: boolean;
  }

  export interface MethodOptions {
    readonly inclusive?: boolean;
  }

  export class RRule {
    constructor(params: Params, options?: Options);
    static validate(params: Params): string[];
    static strict(params: Params, options?: Options): RRule;
    before(dt: Date, options?: MethodOptions): Date | null;
    after(dt: Date, options?: MethodOptions): Date | null;
    between(start: Date, end: Date, options?: MethodOptions): Date[];
    list(options?: { readonly limit?: number }): Date[] & { readonly hasMore?: boolean };
  }

  export default RRule;
}
