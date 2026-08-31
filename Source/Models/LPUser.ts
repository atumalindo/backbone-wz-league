import mongoose, { Schema, Document } from "mongoose";

export interface ILPUser extends Document {
  Nickname: string;
  UserId: string;
  DeviceIdentifier: string;
  DeviceName: string;
  DevicePlatform: Boolean;
  ClientToken: string;
  AccessToken: string;
  RefreshToken?: string;
  ExpireAt?: Date;
}

const UserCollection = new Schema<ILPUser>({
  Nickname: {
    type: String,
    required: true,
    unique: false,
  },
  UserId: {
    type: String,
    required: true,
    unique: true,
  },
  DeviceIdentifier: {
    type: String,
    required: true,
    unique: true,
  },
  DeviceName: {
    type: String,
    required: true,
    unique: false,
  },
  DevicePlatform: {
    type: Number,
    required: true,
    unique: false,
  },
  ClientToken: {
    type: String,
    required: true,
    unique: false,
  },
  AccessToken: {
    type: String,
    required: true,
    unique: false,
  },
  RefreshToken: {
    type: String,
    required: false,
    unique: false,
  },
  ExpireAt: {
    type: Date,
    required: false,
    unique: false,
  },
});

export const LPUser = mongoose.model<ILPUser>("LPUser", UserCollection);
