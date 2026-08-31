export class ApiError {
  _statusCode: number;
  details: string;

  constructor(status: number, details: string) {
    this._statusCode = status;
    this.details = details;
  }

  package(...Vars: string[]) {
    return {
      errorCode: this.details,
      vars: Vars,
    };
  }
}

export const E_NotFound = new ApiError(404, "Oops, this route wasn't found!");

export const E_ServerError = new ApiError(500, "An internal server error occurred.");

export const E_Lockdown = new ApiError(403, "This resource is locked. Come back later.");

export const E_ValidationGeneric = new ApiError(400, "Validation failed.");

export const E_MissingHeaders = new ApiError(400, "A required header is missing.");
