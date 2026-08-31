"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceType = void 0;
exports.ForService = ForService;
const Constants_1 = require("./Constants");
const Errors_1 = require("./Errors");
var ServiceType;
(function (ServiceType) {
    ServiceType[ServiceType["ALL"] = 0] = "ALL";
    ServiceType[ServiceType["Admin"] = 1] = "Admin";
    ServiceType[ServiceType["Public"] = 2] = "Public";
})(ServiceType || (exports.ServiceType = ServiceType = {}));
function ForService(service) {
    return (req, res, next) => {
        let serviceType = Constants_1.SERVICE_TYPE;
        if (req.header("X-Service"))
            // for nginx configurations
            serviceType = ServiceType[req.header("X-Service")];
        req.service = serviceType;
        if (serviceType === ServiceType.ALL)
            return next();
        if (serviceType !== service)
            return res.error(Errors_1.E_NotFound, `${req.baseUrl}${req.url}`);
        next();
    };
}
//# sourceMappingURL=Service.js.map