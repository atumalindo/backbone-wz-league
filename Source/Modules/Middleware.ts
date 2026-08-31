import j from "joi";
import { NextFunction, Request, Response } from "express";
import { Encrypt } from "./Cryptography";

export function ValidateBody(schema: j.Schema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = await schema.validateAsync(req.body);
      next();
    } catch (err) {
      res.status(400).json(err);
    }
  };
}

export function ValidateHeaders(schema: j.ObjectSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.validateAsync(req.headers);
      next();
    } catch (err) {
      res.status(400).json({ error: err });
    }
  };
}

export function ValidateQuery(schema: j.Schema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = await schema.validateAsync(req.query);
      next();
    } catch (err) {
      res.status(400).json(err);
    }
  };
}

export function ValidateParams(schema: j.Schema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.params = await schema.validateAsync(req.params);
      next();
    } catch (err) {
      res.status(400).json(err);
    }
  };
}

export function EncryptResponse(req: Request, res: Response, next: NextFunction) {
  const OriginalResponse = res.json.bind(res);

  res.json = function (body: any): Response {
    (async () => {
      try {
        const EncryptedResponse = await Encrypt(JSON.stringify(body));
        OriginalResponse({
          response: EncryptedResponse,
        });
      } catch (err: any) {
        OriginalResponse(body);
      }
    })();

    return res;
  };

  next();
}
