import type { eventWithTime } from 'howdygo-rrweb-types';

export type eventWithTimeAndPacker = eventWithTime & {
  v: string;
};

export const MARK = 'v1';
