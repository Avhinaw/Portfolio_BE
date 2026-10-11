import { Schema, model, type Types } from 'mongoose';

export interface HostSessionDoc {
  _id: Types.ObjectId;
  sid: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  userAgent?: string;
}

const hostSessionSchema = new Schema<HostSessionDoc>(
  {
    sid: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    userAgent: { type: String, maxlength: 300 },
  },
  { versionKey: false },
);

hostSessionSchema.index({ sid: 1 }, { unique: true });
// Sessions are useless after expiry, so TTL deletion is safe here.
hostSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const HostSession = model<HostSessionDoc>('HostSession', hostSessionSchema);
