"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Register = Register;
exports.GenerateInviteId = GenerateInviteId;
exports.GeneratePrizepoolId = GeneratePrizepoolId;
function Register(req, res, next) {
    res.error = function (Err, ...Vars) {
        if (this.statusCode === 200)
            this.status(Err._statusCode);
        this.json(Err.package(...Vars));
    };
    next();
}
function GenerateInviteId() {
    const time = Date.now();
    const timeComponent = time % 10000000000;
    const randomComponent = Math.floor(Math.random() * 100000);
    return timeComponent * 100000 + randomComponent;
}
function GeneratePrizepoolId() {
    const min = 10n ** 18n;
    const max = 10n ** 19n - 1n;
    const range = max - min + 1n;
    const random = BigInt(Math.floor(Math.random() * Number(range)));
    return min + random;
}
//# sourceMappingURL=Extensions.js.map