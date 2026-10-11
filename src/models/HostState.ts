import { Schema, model } from 'mongoose';

export interface HostStateDoc {
  _id: string;
  available: boolean;
  updatedAt: Date;
}

const hostStateSchema = new Schema<HostStateDoc>(
  {
    _id: { type: String },
    available: { type: Boolean, required: true },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export const HOST_STATE_ID = 'host';
export const HostState = model<HostStateDoc>('HostState', hostStateSchema);
