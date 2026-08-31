"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Encrypt = Encrypt;
exports.Decrypt = Decrypt;
const tslib_1 = require("tslib");
const crypto_1 = tslib_1.__importDefault(require("crypto"));
const Constants_1 = require("./Constants");
async function ImportKey() {
    const enc = new TextEncoder();
    return crypto_1.default.subtle.importKey("raw", enc.encode(Constants_1.KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}
async function Encrypt(plaintext) {
    const enc = new TextEncoder();
    const key = await ImportKey();
    const encrypted = await crypto_1.default.subtle.encrypt({ name: "AES-CBC", iv: enc.encode(Constants_1.IV) }, key, enc.encode(plaintext));
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}
async function Decrypt(encryptedData) {
    const enc = new TextEncoder();
    const data = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
    const key = await ImportKey();
    const decrypted = await crypto_1.default.subtle.decrypt({ name: "AES-CBC", iv: enc.encode(Constants_1.IV) }, key, data);
    return new TextDecoder().decode(decrypted);
}
//# sourceMappingURL=Cryptography.js.map