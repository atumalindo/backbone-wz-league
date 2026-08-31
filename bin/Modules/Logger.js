"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toGradient = toGradient;
exports.msg = msg;
exports.err = err;
exports.warn = warn;
exports.dbg = dbg;
const colorette_1 = require("colorette");
const Constants_1 = require("./Constants");
const ANSI_RESET = "\x1b[0m";
const SUPERSCRIPT_MAP = {
    a: "ᵃ",
    b: "ᵇ",
    c: "ᶜ",
    d: "ᵈ",
    e: "ᵉ",
    f: "ᶠ",
    g: "ᵍ",
    h: "ʰ",
    i: "ⁱ",
    j: "ʲ",
    k: "ᵏ",
    l: "ˡ",
    m: "ᵐ",
    n: "ⁿ",
    o: "ᵒ",
    p: "ᵖ",
    q: "ᑫ",
    r: "ʳ",
    s: "ˢ",
    t: "ᵗ",
    u: "ᵘ",
    v: "ᵛ",
    w: "ʷ",
    x: "ˣ",
    y: "ʸ",
    z: "ᶻ",
    A: "ᴬ",
    B: "ᴮ",
    C: "ᶜ",
    D: "ᴰ",
    E: "ᴱ",
    F: "ᶠ",
    G: "ᴳ",
    H: "ᴴ",
    I: "ᴵ",
    J: "ᴶ",
    K: "ᴷ",
    L: "ᴸ",
    M: "ᴹ",
    N: "ᴺ",
    O: "ᴼ",
    P: "ᴾ",
    Q: "Q",
    R: "ᴿ",
    S: "ˢ",
    T: "ᵀ",
    U: "ᵁ",
    V: "ⱽ",
    W: "ᵂ",
    X: "ˣ",
    Y: "ʸ",
    Z: "ᶻ",
    0: "⁰",
    1: "¹",
    2: "²",
    3: "³",
    4: "⁴",
    5: "⁵",
    6: "⁶",
    7: "⁷",
    8: "⁸",
    9: "⁹",
};
function hexToAnsi(Hex) {
    const R = parseInt(Hex.substring(0, 2), 16);
    const G = parseInt(Hex.substring(2, 4), 16);
    const B = parseInt(Hex.substring(4, 6), 16);
    return `\x1b[38;2;${R};${G};${B}m`;
}
function hexToRgb(Hex) {
    const Int = parseInt(Hex.replace(/^#/, ""), 16);
    return {
        R: (Int >> 16) & 255,
        G: (Int >> 8) & 255,
        B: Int & 255,
    };
}
function toSuperscript(Input) {
    return Input.split("")
        .map((Char) => SUPERSCRIPT_MAP[Char] ?? Char)
        .join("");
}
function parseColorTags(Input) {
    Input = Input.replace(/<sup><#([a-fA-F0-9]{6})>(.*?)<\/sup><\/color>/g, (_, Hex, Text) => {
        const Ansi = hexToAnsi(Hex);
        const Superscript = toSuperscript(Text);
        return `${Ansi}${Superscript}${ANSI_RESET}`;
    });
    Input = Input.replace(/<#([a-fA-F0-9]{6})>(.*?)<\/color>/g, (_, Hex, Text) => {
        const Ansi = hexToAnsi(Hex);
        return `${Ansi}${Text}${ANSI_RESET}`;
    });
    return Input;
}
function getTimestamp() {
    return (0, colorette_1.gray)(new Date().toISOString());
}
function formatPrefix(Label, ColorFn) {
    return `[${ColorFn(Label)}]`;
}
function toGradient(Text, From, To) {
    const StartRgb = hexToRgb(From);
    const EndRgb = hexToRgb(To);
    return (Text.split("")
        .map((Char, Index) => {
        const Ratio = Index / Math.max(Text.length - 1, 1);
        const R = Math.round(StartRgb.R + Ratio * (EndRgb.R - StartRgb.R));
        const G = Math.round(StartRgb.G + Ratio * (EndRgb.G - StartRgb.G));
        const B = Math.round(StartRgb.B + Ratio * (EndRgb.B - StartRgb.B));
        return `\x1b[38;2;${R};${G};${B}m${Char}`;
    })
        .join("") + ANSI_RESET);
}
function log(Content, Prefix, ColorFn) {
    const Parsed = parseColorTags(Content);
    console.log(`${getTimestamp()} ${formatPrefix(Prefix, ColorFn)} ${Parsed}`);
}
function msg(Content, Prefix = Constants_1.PROJECT_NAME) {
    log(Content, Prefix, colorette_1.green);
}
function err(Content, Prefix = Constants_1.PROJECT_NAME) {
    log(Content, `ERROR | ${Prefix}`, colorette_1.red);
}
function warn(Content, Prefix = Constants_1.PROJECT_NAME) {
    log(Content, `WARNING | ${Prefix}`, colorette_1.yellow);
}
function dbg(Content, Prefix = Constants_1.PROJECT_NAME) {
    if (!Constants_1.IS_DEBUG)
        return;
    log(Content, `DEBUG | ${Prefix}`, colorette_1.magenta);
}
//# sourceMappingURL=Logger.js.map