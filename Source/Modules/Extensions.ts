import { Request, Response, NextFunction } from "express";
import { ApiError } from "./Errors";
import { ServiceType } from "./Service";

declare global {
  namespace Express {
    interface Request {
      service: ServiceType;
    }

    interface Response {
      error(err: ApiError, ...vars: string[]): void;
    }
  }
}

export function Register(req: Request, res: Response, next: NextFunction) {
  res.error = function (Err: ApiError, ...Vars: string[]) {
    if (this.statusCode === 200) this.status(Err._statusCode);

    this.json(Err.package(...Vars));
  };

  next();
}

export function GenerateInviteId(): number {
  const time = Date.now();
  const timeComponent = time % 10000000000;
  const randomComponent = Math.floor(Math.random() * 100000);

  return timeComponent * 100000 + randomComponent;
}

export function GeneratePrizepoolId(): bigint {
  const min = 10n ** 18n;
  const max = 10n ** 19n - 1n;
  const range = max - min + 1n;
  const random = BigInt(Math.floor(Math.random() * Number(range)));
  return min + random;
}

