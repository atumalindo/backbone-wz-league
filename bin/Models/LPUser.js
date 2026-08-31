"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LPUser = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
const UserCollection = new mongoose_1.Schema({
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
exports.LPUser = mongoose_1.default.model("LPUser", UserCollection);
//# sourceMappingURL=LPUser.js.map