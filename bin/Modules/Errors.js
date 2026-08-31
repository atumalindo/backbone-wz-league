"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.E_MissingHeaders = exports.E_ValidationGeneric = exports.E_Lockdown = exports.E_ServerError = exports.E_NotFound = exports.ApiError = void 0;
class ApiError {
    _statusCode;
    details;
    constructor(status, details) {
        this._statusCode = status;
        this.details = details;
    }
    package(...Vars) {
        return {
            errorCode: this.details,
            vars: Vars,
        };
    }
}
exports.ApiError = ApiError;
exports.E_NotFound = new ApiError(404, "Oops, this route wasn't found!");
exports.E_ServerError = new ApiError(500, "An internal server error occurred.");
exports.E_Lockdown = new ApiError(403, "This resource is locked. Come back later.");
exports.E_ValidationGeneric = new ApiError(400, "Validation failed.");
exports.E_MissingHeaders = new ApiError(400, "A required header is missing.");
//# sourceMappingURL=Errors.js.map