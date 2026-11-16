import { Schema, model } from 'mongoose';
import type { AvailabilityWindow } from '../utils/availability';

export interface HostStateDoc {
  _id: string;
  available: boolean;
  scheduleEnabled: boolean;
  scheduleTimezone: string;
  unavailableWindows: AvailabilityWindow[];
  updatedAt: Date;
}

const availabilityWindowSchema = new Schema<AvailabilityWindow>(
  {
    dayOfWeek: { type: Number, required: true },
    startMinute: { type: Number, required: true },
    endMinute: { type: Number, required: true },
  },
  { _id: false },
);

const hostStateSchema = new Schema<HostStateDoc>(
  {
    _id: { type: String },
    available: { type: Boolean, required: true },
    scheduleEnabled: { type: Boolean, default: false },
    scheduleTimezone: { type: String, default: 'UTC' },
    unavailableWindows: { type: [availabilityWindowSchema], default: [] },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export const HOST_STATE_ID = 'host';
export const HostState = model<HostStateDoc>('HostState', hostStateSchema);
