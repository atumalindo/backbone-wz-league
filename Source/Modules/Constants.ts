import { ServiceType } from "./Service";

export const PROJECT_NAME = process.env.PROJECT_NAME ?? ""; // Default prefix for the logger module.
export const BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT ?? "20mb"; // Doesn't accept requests with body sizes larger than this value.
export const SERVER_URL = process.env.SERVER_URL ?? "localhost"; // The server's URL. Not used for a lot by default.
export const IS_HTTPS = process.env.IS_HTTPS ?? SERVER_URL !== "localhost";
export const SHOW_PORT = (process.env.SHOW_PORT ?? "false") == "true";
export const PORT = process.env.PORT ?? 80; // Port for the server to run on.
export const ENVIRONMENT = process.env.ENVIRONMENT ?? "develop";
export const IS_DEBUG = ENVIRONMENT.toLowerCase().includes("develop") || ENVIRONMENT.toLowerCase().includes("stage"); // IS_DEBUG can be used to enable test endpoints, unsafe code and more.
export const SERVICE_TYPE = ServiceType[(process.env.SERVICE_TYPE ?? "ALL") as keyof typeof ServiceType];
export const KEY = "K7mP9vR2nL4xW8qF6jT3yH5sB1dN0gE7";
export const IV = "A9xM2vC8pL5kR3wQ";
