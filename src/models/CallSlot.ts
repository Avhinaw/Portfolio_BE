import { Schema, model, type Types } from 'mongoose';

/**
 * One document per occupied call slot. Unique indexes on `slot` and `roomId` make slot acquisition
 * atomic across any number of backend instances (no in-memory counters).
 */
export interface CallSlotDoc {
  _id: Types.ObjectId;
  slot: number;
  roomId: string;
  createdAt: Date;
}

const callSlotSchema = new Schema<CallSlotDoc>(
  {
    slot: { type: Number, required: true },
    roomId: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

callSlotSchema.index({ slot: 1 }, { unique: true });
callSlotSchema.index({ roomId: 1 }, { unique: true });

export const CallSlot = model<CallSlotDoc>('CallSlot', callSlotSchema);
