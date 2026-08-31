"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidateBody = ValidateBody;
exports.ValidateHeaders = ValidateHeaders;
exports.ValidateQuery = ValidateQuery;
exports.ValidateParams = ValidateParams;
exports.EncryptResponse = EncryptResponse;
const Cryptography_1 = require("./Cryptography");
function ValidateBody(schema) {
    return async (req, res, next) => {
        try {
            req.body = await schema.validateAsync(req.body);
            next();
        }
        catch (err) {
            res.status(400).json(err);
        }
    };
}
function ValidateHeaders(schema) {
    return async (req, res, next) => {
        try {
            await schema.validateAsync(req.headers);
            next();
        }
        catch (err) {
            res.status(400).json({ error: err });
        }
    };
}
function ValidateQuery(schema) {
    return async (req, res, next) => {
        try {
            req.query = await schema.validateAsync(req.query);
            next();
        }
        catch (err) {
            res.status(400).json(err);
        }
    };
}
function ValidateParams(schema) {
    return async (req, res, next) => {
        try {
            req.params = await schema.validateAsync(req.params);
            next();
        }
        catch (err) {
            res.status(400).json(err);
        }
    };
}
function EncryptResponse(req, res, next) {
    const OriginalResponse = res.json.bind(res);
    res.json = function (body) {
        (async () => {
            try {
                const EncryptedResponse = await (0, Cryptography_1.Encrypt)(JSON.stringify(body));
                OriginalResponse({
                    response: EncryptedResponse,
                });
            }
            catch (err) {
                OriginalResponse(body);
            }
        })();
        return res;
    };
    next();
}
//# sourceMappingURL=Middleware.js.map