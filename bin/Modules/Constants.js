"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IV = exports.KEY = exports.SERVICE_TYPE = exports.IS_DEBUG = exports.ENVIRONMENT = exports.PORT = exports.SHOW_PORT = exports.IS_HTTPS = exports.SERVER_URL = exports.BODY_SIZE_LIMIT = exports.PROJECT_NAME = void 0;
const Service_1 = require("./Service");
exports.PROJECT_NAME = process.env.PROJECT_NAME ?? ""; // Default prefix for the logger module.
exports.BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT ?? "20mb"; // Doesn't accept requests with body sizes larger than this value.
exports.SERVER_URL = process.env.SERVER_URL ?? "localhost"; // The server's URL. Not used for a lot by default.
exports.IS_HTTPS = process.env.IS_HTTPS ?? exports.SERVER_URL !== "localhost";
exports.SHOW_PORT = (process.env.SHOW_PORT ?? "false") == "true";
exports.PORT = process.env.PORT ?? 80; // Port for the server to run on.
exports.ENVIRONMENT = process.env.ENVIRONMENT ?? "develop";
exports.IS_DEBUG = exports.ENVIRONMENT.toLowerCase().includes("develop") || exports.ENVIRONMENT.toLowerCase().includes("stage"); // IS_DEBUG can be used to enable test endpoints, unsafe code and more.
exports.SERVICE_TYPE = Service_1.ServiceType[(process.env.SERVICE_TYPE ?? "ALL")];
exports.KEY = "K7mP9vR2nL4xW8qF6jT3yH5sB1dN0gE7";
exports.IV = "A9xM2vC8pL5kR3wQ";
//# sourceMappingURL=Constants.js.map